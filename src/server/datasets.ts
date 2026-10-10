import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from './config.js';
import type { AssetRow, Db } from './db.js';
import type { Indexer } from './indexer.js';
import type { Trash } from './trash.js';
import { isIgnoredName, mediaType, sidecarNames, stemOf } from './media.js';
import { HttpError, isInside, toPosix } from './paths.js';
import { exists, fsMessage, moveFile, settledFile, sidecarsExist } from './trash.js';

/**
 * Training datasets (wandering-lora layout): every first-level folder under
 * `datasets.root` is a dataset, and its media lives in `<dataset>/<datasets.subfolder>/`.
 * Assets can be copied or moved there together with their caption sidecars.
 */

export type DatasetMode = 'move' | 'copy';

/** What to do when the file name is already taken in the dataset: ask (409), replace, or keep both (rename). */
export const CONFLICT_CHOICES = ['ask', 'replace', 'rename'] as const;
export type ConflictChoice = (typeof CONFLICT_CHOICES)[number];

export interface DatasetInfo {
  name: string;
  /** Media files in the dataset's images folder. */
  count: number;
}

export interface DatasetResult {
  mode: DatasetMode;
  dataset: string;
  created: boolean;
  /** File name in the dataset (differs from the original when both were kept). */
  name: string;
  /** An existing file of that name was replaced (and moved to the trash). */
  replaced: boolean;
  /** For a move: the asset row afterwards (null when the dataset is not a library). */
  row: AssetRow | null;
}

/** A dataset name is one plain folder name: no separators, no leading dot. */
export function checkDatasetName(v: unknown): string {
  if (typeof v !== 'string') throw new HttpError('dataset must be a string', 400);
  const name = v.trim();
  if (!name || name.length > 100 || name.startsWith('.') || /[/\\\0]/.test(name) || /[\x00-\x1f]/.test(name)) {
    throw new HttpError('Invalid dataset name', 400);
  }
  return name;
}

/** Copies without ever replacing the destination, keeping the mtime; removes a partial copy on failure. */
async function copyFile(src: string, dest: string) {
  try {
    await fs.promises.copyFile(src, dest, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
    const [a, b] = await Promise.all([fs.promises.stat(src), fs.promises.stat(dest)]);
    if (a.size !== b.size) throw new Error('copy verification failed');
    await fs.promises.utimes(dest, a.atime, a.mtime);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') await fs.promises.rm(dest, { force: true });
    throw err;
  }
}

export interface AddOptions {
  /** Create the dataset if it does not exist yet. */
  create?: boolean;
  onConflict?: ConflictChoice;
  expected?: { size?: number; mtimeMs?: number };
}

export class Datasets {
  readonly root: string;
  readonly subfolder: string;

  constructor(readonly cfg: AppConfig, readonly db: Db, readonly indexer: Indexer, readonly trash: Trash) {
    this.root = cfg.datasets.root;
    this.subfolder = cfg.datasets.subfolder;
  }

  private imagesDir(name: string) {
    return this.subfolder ? path.join(this.root, name, this.subfolder) : path.join(this.root, name);
  }

  async list(): Promise<DatasetInfo[]> {
    const ents = await fs.promises.readdir(this.root, { withFileTypes: true }).catch(() => []);
    const out: DatasetInfo[] = [];
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const st = await fs.promises.stat(path.join(this.root, e.name)).catch(() => null);
      if (!st?.isDirectory()) continue;
      const files = await fs.promises.readdir(this.imagesDir(e.name)).catch(() => []);
      out.push({ name: e.name, count: files.filter((f) => !f.startsWith('.') && mediaType(f)).length });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  }

  add(id: number, dataset: string, mode: DatasetMode, opts: AddOptions = {}) {
    return this.indexer.exclusive(() => this.doAdd(id, dataset, mode, opts));
  }

  private async doAdd(id: number, datasetIn: string, mode: DatasetMode, opts: AddOptions): Promise<DatasetResult> {
    const dataset = checkDatasetName(datasetIn);
    const row = this.db.asset(id);
    if (!row || row.status !== 'ready') throw new HttpError('asset not found', 404);
    const lib = this.indexer.libs.get(row.library_id);
    if (!lib?.realRoot) throw new HttpError('library is unavailable', 404);
    if (mode === 'move' && !lib.cfg.writable) throw new HttpError(`Library "${lib.cfg.name}" is read-only; copy instead`, 403);

    const src = await settledFile(this.indexer, row, opts.expected);
    // Where the file is linked (not where a symlink points): its sidecars live next to it.
    const linked = path.join(lib.realRoot, ...row.rel_path.split('/'));
    if (mode === 'move' && (await fs.promises.lstat(linked)).isSymbolicLink()) {
      throw new HttpError('Symlinked files cannot be moved; copy instead', 400);
    }
    const srcDir = path.dirname(linked);

    const dsDir = path.join(this.root, dataset);
    const created = !(await exists(dsDir));
    if (created && !opts.create) throw new HttpError(`There is no dataset "${dataset}"`, 404);
    const destDir = this.imagesDir(dataset);
    try {
      await fs.promises.mkdir(destDir, { recursive: true });
    } catch (err) {
      throw new HttpError(`Could not create the dataset folder: ${fsMessage(err)}`, 500);
    }
    const realDest = await fs.promises.realpath(destDir);
    if (realDest === (await fs.promises.realpath(srcDir))) throw new HttpError(`This file is already in "${dataset}"`, 409);

    // A name is taken if the file or either of its sidecars exists.
    const ext = path.extname(row.name);
    const taken = async (n: string) => (await exists(path.join(realDest, n))) || (await sidecarsExist(realDest, n));
    let name = row.name;
    const onConflict = opts.onConflict ?? 'ask';
    if (await taken(name)) {
      if (onConflict === 'ask') {
        const names = [row.name, sidecarNames(row.name).txt, sidecarNames(row.name).json];
        const existing: string[] = [];
        for (const n of names) if (await exists(path.join(realDest, n))) existing.push(n);
        throw new HttpError(`"${row.name}" already exists in "${dataset}"`, 409, { conflict: { name: row.name, existing } });
      }
      if (onConflict === 'rename') {
        for (let n = 2; await taken(name); n++) {
          if (n > 999) throw new HttpError('no free file name in the dataset', 409);
          name = `${stemOf(row.name)}-${n}${ext}`;
        }
      }
    }
    // Replace: the old file and its sidecars go to the trash first (restored if this fails).
    const undoReplace = onConflict === 'replace' && name === row.name ? await this.setAside(realDest, name, dataset) : null;

    const from = sidecarNames(row.name);
    const to = sidecarNames(name);
    const pairs: [string, string][] = [];
    for (const k of ['txt', 'json'] as const) {
      const st = await fs.promises.lstat(path.join(srcDir, from[k])).catch(() => null);
      if (st?.isFile()) pairs.push([path.join(srcDir, from[k]), path.join(realDest, to[k])]);
    }
    pairs.push([mode === 'move' ? linked : src, path.join(realDest, name)]);

    // All or nothing: sidecars first, then the file; undo what was done if a step fails.
    const done: [string, string][] = [];
    try {
      for (const [a, b] of pairs) {
        if (mode === 'move') await moveFile(a, b);
        else await copyFile(a, b);
        done.push([a, b]);
      }
    } catch (err) {
      for (const [a, b] of done.reverse()) {
        if (mode === 'move') await moveFile(b, a).catch(() => {});
        else await fs.promises.rm(b, { force: true }).catch(() => {});
      }
      await undoReplace?.().catch(() => {});
      const code = (err as NodeJS.ErrnoException).code;
      throw new HttpError(`Could not ${mode} to "${dataset}": ${fsMessage(err)}`, code === 'EEXIST' ? 409 : 500);
    }

    let after: AssetRow | null = null;
    if (mode === 'move') {
      after = await this.relocate(row, path.join(realDest, name));
      // Listed as removed so views of the old place drop it; views that still match re-add it.
      this.indexer.notify(row.library_id, [row.id], after ? [row.id] : []);
    } else {
      const target = this.libraryAt(path.join(realDest, name));
      if (target) void this.indexer.scanLibrary(target.lib);
    }
    return { mode, dataset, created, name, replaced: !!undoReplace, row: after };
  }

  /**
   * Moves what occupies `name` in `dir` (the file and its sidecars) to the trash. An
   * indexed asset goes through the normal trash, so it can be restored from the Trash
   * view with its rating; loose files go to a folder in the trash that expires with it.
   * Returns a function that puts everything back.
   */
  private async setAside(dir: string, name: string, dataset: string): Promise<() => Promise<void>> {
    const undo: (() => Promise<void>)[] = [];
    const putBack = async () => {
      for (const u of undo.reverse()) await u();
    };
    try {
      const target = this.libraryAt(path.join(dir, name));
      const targetLib = target && this.indexer.libs.get(target.lib)?.cfg;
      if (targetLib && !targetLib.writable) throw new HttpError(`Library "${targetLib.name}" is read-only`, 403);
      const live = target && this.db.liveAt(target.lib, target.rel);
      if (live) {
        await this.trash.doTrash(live.id);
        undo.push(async () => {
          await this.trash.doRestore(live.id);
        });
      }
      const n = sidecarNames(name);
      const loose: string[] = [];
      for (const f of [name, n.txt, n.json]) if (await exists(path.join(dir, f))) loose.push(f);
      if (loose.length) {
        const moved = await this.trash.stash(dir, loose, dataset);
        undo.push(() => this.trash.unstash(moved));
      }
    } catch (err) {
      await putBack().catch(() => {});
      throw new HttpError(`Could not move the existing "${name}" to the trash: ${err instanceof HttpError ? err.message : fsMessage(err)}`, 500);
    }
    return putBack;
  }

  /** The library (and library-relative path) a file at `abs` belongs to, if any. */
  private libraryAt(abs: string): { lib: string; rel: string } | null {
    for (const s of this.indexer.libs.values()) {
      if (!s.realRoot || !isInside(s.realRoot, abs)) continue;
      const rel = toPosix(path.relative(s.realRoot, abs));
      if (!s.cfg.recursive && rel.includes('/')) continue;
      if (rel.split('/').some(isIgnoredName)) continue;
      return { lib: s.cfg.id, rel };
    }
    return null;
  }

  /**
   * After a move, points the row at its new place when that is inside a library, so
   * rating, favorite and metadata follow the file; otherwise marks it missing (kept for
   * a while, and re-attached if the file shows up in a library later).
   */
  private async relocate(row: AssetRow, abs: string): Promise<AssetRow | null> {
    const target = this.libraryAt(abs);
    if (!target) {
      this.db.run("UPDATE assets SET status = 'missing', missing_since_ms = ? WHERE id = ?", Date.now(), row.id);
      return null;
    }
    const st = await fs.promises.stat(abs);
    const { lib, rel } = target;
    this.db.tx(() => {
      const dup = this.db.liveAt(lib, rel);
      if (dup && dup.id !== row.id) this.db.run('DELETE FROM assets WHERE id = ?', dup.id);
      this.db.run(
        `UPDATE assets SET library_id = ?, rel_path = ?, folder = ?, name = ?, size = ?, mtime_ms = ?, inode = ?, birth_ms = ?,
           missing_since_ms = NULL WHERE id = ?`,
        lib, rel, rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '', path.posix.basename(rel),
        st.size, Math.floor(st.mtimeMs), st.ino, Math.floor(st.birthtimeMs), row.id,
      );
    });
    const moved = this.db.asset(row.id)!;
    await this.indexer.syncCaption(moved);
    this.indexer.notify(lib);
    return this.db.asset(row.id)!;
  }
}
