import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from './config.js';
import type { AssetRow, Db } from './db.js';
import { looksComplete } from './fileinfo.js';
import type { Indexer } from './indexer.js';
import { sidecarNames } from './media.js';
import { HttpError, isInside, resolveInside, resolveTargetInside } from './paths.js';

/**
 * Moves a file without ever replacing an existing destination: hard-link then
 * unlink on the same filesystem (link fails with EEXIST if the target exists),
 * or exclusive copy + verify + unlink across filesystems.
 */
async function moveFile(src: string, dest: string) {
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.promises.link(src, dest);
    await fs.promises.unlink(src);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'ENOTSUP') throw err;
    await fs.promises.copyFile(src, dest, fs.constants.COPYFILE_EXCL);
    const [a, b] = await Promise.all([fs.promises.stat(src), fs.promises.stat(dest)]);
    if (a.size !== b.size) {
      await fs.promises.rm(dest, { force: true });
      throw new Error('copy verification failed');
    }
    await fs.promises.utimes(dest, a.atime, a.mtime);
    await fs.promises.unlink(src);
  }
}

async function exists(p: string): Promise<boolean> {
  return fs.promises.lstat(p).then(() => true, () => false);
}

function fsMessage(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  switch (code) {
    case 'EACCES':
    case 'EPERM':
      return 'Permission denied by the filesystem';
    case 'EROFS':
      return 'The filesystem is read-only';
    case 'ENOSPC':
      return 'No space left on device';
    case 'ENOENT':
      return 'The file no longer exists';
    case 'EBUSY':
      return 'The file is busy';
    case 'EEXIST':
      return 'A file with that name already exists';
    default:
      return (err as Error).message;
  }
}

/**
 * Moves the caption sidecars of `fromName` in `fromDir` to those of `toName` in
 * `toDir`. All or nothing: if one move fails, the ones already done are undone.
 * Symlinked sidecars are left alone.
 */
async function moveSidecars(fromDir: string, fromName: string, toDir: string, toName: string) {
  const from = sidecarNames(fromName);
  const to = sidecarNames(toName);
  const done: [string, string][] = [];
  try {
    for (const k of ['txt', 'json'] as const) {
      const src = path.join(fromDir, from[k]);
      const st = await fs.promises.lstat(src).catch(() => null);
      if (!st?.isFile()) continue;
      const dest = path.join(toDir, to[k]);
      await moveFile(src, dest);
      done.push([src, dest]);
    }
  } catch (err) {
    for (const [src, dest] of done.reverse()) await moveFile(dest, src).catch(() => {});
    throw err;
  }
}

async function sidecarsExist(dir: string, name: string): Promise<boolean> {
  const n = sidecarNames(name);
  return (await exists(path.join(dir, n.txt))) || (await exists(path.join(dir, n.json)));
}

export class Trash {
  readonly root: string;

  constructor(readonly cfg: AppConfig, readonly db: Db, readonly indexer: Indexer) {
    this.root = path.join(cfg.dataDir, 'trash');
  }

  private library(id: string) {
    const state = this.indexer.libs.get(id);
    if (!state) throw new HttpError('unknown library', 404);
    return state;
  }

  /** Moves one asset's file into the trash. The DB row keeps favorite/rating/metadata. */
  trash(id: number, expected?: { size?: number; mtimeMs?: number }): Promise<AssetRow> {
    return this.indexer.exclusive(() => this.doTrash(id, expected));
  }

  private async doTrash(id: number, expected?: { size?: number; mtimeMs?: number }): Promise<AssetRow> {
    const row = this.db.asset(id);
    if (!row || row.status !== 'ready') throw new HttpError('asset not found', 404);
    const lib = this.library(row.library_id);
    if (!lib.cfg.writable) throw new HttpError(`Library "${lib.cfg.name}" is read-only`, 403);

    const abs = await resolveInside(lib.cfg.path, row.rel_path);
    const lst = await fs.promises.lstat(path.join(lib.realRoot ?? lib.cfg.path, ...row.rel_path.split('/')));
    if (lst.isSymbolicLink()) throw new HttpError('Symlinked files cannot be deleted from the gallery', 400);
    const st = await fs.promises.stat(abs);
    if (!st.isFile()) throw new HttpError('not a regular file', 400);

    // Guard against deleting something that is still being written.
    const age = Date.now() - st.mtimeMs;
    if (age < this.indexer.stableMs || (age < 10 * 60_000 && !(await looksComplete(abs).catch(() => false)))) {
      throw new HttpError('This file is still being written. Try again in a moment.', 409);
    }
    // Guard against acting on stale UI state (file replaced since it was displayed).
    if (st.size !== row.size || Math.floor(st.mtimeMs) !== row.mtime_ms ||
        (expected?.size !== undefined && expected.size !== row.size) ||
        (expected?.mtimeMs !== undefined && expected.mtimeMs !== row.mtime_ms)) {
      void this.indexer.scanLibrary(row.library_id);
      throw new HttpError('The file changed on disk. Refresh and try again.', 409);
    }

    const dest = path.join(this.root, row.library_id, `${row.id}-${Date.now()}`, path.posix.basename(row.rel_path));
    // Record where the file is going first, so a crash mid-move can be reconciled at startup.
    this.db.run(
      "UPDATE assets SET status = 'trashed', trashed_at_ms = ?, trash_path = ?, missing_since_ms = NULL WHERE id = ?",
      Date.now(), path.relative(this.root, dest), row.id,
    );
    // Caption sidecars go first and travel with the file, so they never attach to a later file of the same name.
    const srcDir = path.dirname(path.join(lib.realRoot ?? lib.cfg.path, ...row.rel_path.split('/')));
    let sidecarsMoved = false;
    try {
      await moveSidecars(srcDir, row.name, path.dirname(dest), row.name);
      sidecarsMoved = true;
      await moveFile(abs, dest);
    } catch (err) {
      if (sidecarsMoved) await moveSidecars(path.dirname(dest), row.name, srcDir, row.name).catch(() => {});
      this.db.run("UPDATE assets SET status = 'ready', trashed_at_ms = NULL, trash_path = NULL WHERE id = ?", row.id);
      await fs.promises.rmdir(path.dirname(dest)).catch(() => {});
      throw new HttpError(`Could not move file to trash: ${fsMessage(err)}`, 500);
    }
    this.indexer.notify(row.library_id, [row.id]);
    return this.db.asset(row.id)!;
  }

  private trashFile(row: AssetRow): string {
    if (!row.trash_path) throw new HttpError('asset has no trash file', 409);
    const abs = path.resolve(this.root, row.trash_path);
    if (!isInside(this.root, abs) || abs === this.root) throw new HttpError('invalid trash path', 400);
    return abs;
  }

  /** Moves a trashed file back to its original location (or a free name next to it). */
  restore(id: number): Promise<AssetRow> {
    return this.indexer.exclusive(() => this.doRestore(id));
  }

  private async doRestore(id: number): Promise<AssetRow> {
    const row = this.db.asset(id);
    if (!row || row.status !== 'trashed') throw new HttpError('asset is not in the trash', 404);
    const lib = this.library(row.library_id);
    if (!lib.cfg.writable) throw new HttpError(`Library "${lib.cfg.name}" is read-only`, 403);
    const src = this.trashFile(row);
    if (!(await exists(src))) throw new HttpError('The trashed file is gone and cannot be restored', 410);

    let rel = row.rel_path;
    let target = await resolveTargetInside(lib.cfg.path, rel);
    const taken = async () => (await exists(target)) || !!this.db.liveAt(row.library_id, rel) ||
      (await sidecarsExist(path.dirname(target), path.posix.basename(rel)));
    for (let n = 1; await taken(); n++) {
      if (n > 999) throw new HttpError('no free filename to restore to', 409);
      const ext = path.posix.extname(row.rel_path);
      rel = `${row.rel_path.slice(0, row.rel_path.length - ext.length)} (restored${n > 1 ? ` ${n}` : ''})${ext}`;
      target = await resolveTargetInside(lib.cfg.path, rel);
    }
    try {
      await moveFile(src, target);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      throw new HttpError(`Could not restore file: ${fsMessage(err)}`, code === 'EEXIST' ? 409 : 500);
    }
    try {
      await moveSidecars(path.dirname(src), row.name, path.dirname(target), path.posix.basename(rel));
    } catch {
      /* the caption stays in the trash folder; the restored file is what matters */
    }
    await fs.promises.rmdir(path.dirname(src)).catch(() => {});
    const st = await fs.promises.stat(target);
    this.markRestored(row.id, row.library_id, rel, st);
    await this.indexer.syncCaption(this.db.asset(row.id)!);
    this.indexer.notify(row.library_id, [], [row.id]);
    return this.db.asset(row.id)!;
  }

  /** Puts a row back to 'ready' at `rel`, absorbing any row a concurrent scan created for the same file. */
  private markRestored(id: number, libraryId: string, rel: string, st: fs.Stats) {
    this.db.tx(() => {
      const dup = this.db.liveAt(libraryId, rel);
      if (dup && dup.id !== id) this.db.run('DELETE FROM assets WHERE id = ?', dup.id);
      this.db.run(
        `UPDATE assets SET status = 'ready', library_id = ?, rel_path = ?, folder = ?, name = ?, size = ?, mtime_ms = ?,
           inode = ?, birth_ms = ?, trashed_at_ms = NULL, trash_path = NULL, missing_since_ms = NULL WHERE id = ?`,
        libraryId, rel, rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '', path.posix.basename(rel),
        st.size, Math.floor(st.mtimeMs), st.ino, Math.floor(st.birthtimeMs), id,
      );
    });
  }

  /**
   * Startup repair after a crash during trash: if a trashed row's file never
   * left the library (or never arrived in the trash), put it back to 'ready'.
   */
  async reconcile(): Promise<number> {
    let fixed = 0;
    for (const row of this.db.all<AssetRow>("SELECT * FROM assets WHERE status = 'trashed'")) {
      let inTrash = false;
      try {
        inTrash = !!row.trash_path && (await exists(this.trashFile(row)));
      } catch {
        /* invalid path: treat as missing */
      }
      if (inTrash) continue;
      const lib = this.indexer.libs.get(row.library_id);
      if (!lib) continue;
      try {
        const abs = await resolveInside(lib.cfg.path, row.rel_path);
        const st = await fs.promises.stat(abs);
        if (this.db.liveAt(row.library_id, row.rel_path)) continue;
        // Sidecars may have been moved before the crash.
        if (row.trash_path && !(await sidecarsExist(path.dirname(abs), row.name))) {
          await moveSidecars(path.dirname(path.resolve(this.root, row.trash_path)), row.name, path.dirname(abs), row.name).catch(() => {});
        }
        this.markRestored(row.id, row.library_id, row.rel_path, st);
        fixed++;
      } catch {
        /* neither in the trash nor in the library: leave it; restore reports 410 */
      }
    }
    return fixed;
  }

  /** Permanently deletes a trashed asset's file and its database record. */
  async purge(id: number) {
    const row = this.db.asset(id);
    if (!row || row.status !== 'trashed') throw new HttpError('asset is not in the trash', 404);
    const file = this.trashFile(row);
    const names = sidecarNames(row.name);
    try {
      for (const n of [names.txt, names.json]) await fs.promises.rm(path.join(path.dirname(file), n), { force: true });
      await fs.promises.rm(file, { force: true });
    } catch (err) {
      throw new HttpError(`Could not delete file: ${fsMessage(err)}`, 500);
    }
    await fs.promises.rmdir(path.dirname(file)).catch(() => {});
    this.db.run('DELETE FROM assets WHERE id = ?', row.id);
  }

  /** Deletes trash items older than the retention period. */
  async purgeExpired(now = Date.now()): Promise<number> {
    const cutoff = now - this.cfg.trash.retentionDays * 86_400_000;
    const rows = this.db.all<{ id: number }>(
      "SELECT id FROM assets WHERE status = 'trashed' AND trashed_at_ms < ?", cutoff,
    );
    let n = 0;
    for (const { id } of rows) {
      try {
        await this.purge(id);
        n++;
      } catch {
        /* reported on next run */
      }
    }
    return n;
  }
}
