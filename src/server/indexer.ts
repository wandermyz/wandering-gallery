import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import chokidar, { type FSWatcher } from 'chokidar';
import type { AppConfig, LibraryConfig } from './config.js';
import { effectiveStatus, hasCandidate, readSidecars, sigOf } from './captions.js';
import type { AssetRow, CaptionRow, Db } from './db.js';
import { fingerprint, looksComplete } from './fileinfo.js';
import { isIgnoredName, mediaType, sidecarNames, sidecarStem } from './media.js';
import { extract } from './metadata/extract.js';
import { checkRelPath, isInside, toPosix } from './paths.js';
import { folderOf, statEntry, walkLibrary, type FileEntry } from './scanner.js';
import { ensureThumb } from './thumbs.js';

export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface LibraryState {
  cfg: LibraryConfig;
  realRoot: string | null;
  /** Device of `realRoot` when opened; a change means the filesystem was unmounted or swapped. */
  rootDev: number | null;
  error: string | null;
  scanning: boolean;
  lastScanMs: number | null;
  watcher: FSWatcher | null;
}

export interface ChangeEvent {
  libraries: string[];
  removed: number[];
  /** Assets whose caption sidecars changed. */
  captions: number[];
}

type CaptionOwner = Pick<AssetRow, 'id' | 'library_id' | 'rel_path' | 'folder' | 'name'>;

/** Missing rows are kept this long so a file that comes back (moved, remounted) keeps its rating. */
const MISSING_RETENTION_MS = 30 * 24 * 3600_000;
/** Young files must also pass a structural completeness check before indexing. */
const YOUNG_FILE_MS = 10 * 60_000;
const WATCH_DEBOUNCE_MS = 1500;
/** How recently a copy must have appeared to inherit state from a vanished original. */
const ADOPT_WINDOW_MS = 24 * 3600_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Same underlying file (modified in place) vs. a different file now at the
 * same path. Inode numbers are reused quickly on ext4, so creation time is
 * compared too where the filesystem reports it.
 */
function sameFile(row: Pick<AssetRow, 'inode' | 'birth_ms'>, f: FileEntry): boolean {
  if (row.inode !== f.ino) return false;
  return !row.birth_ms || !f.birthMs || row.birth_ms === f.birthMs;
}

export class Indexer extends EventEmitter {
  readonly libs = new Map<string, LibraryState>();
  private pendingPaths = new Map<string, Set<string>>();
  private pendingScans = new Set<string>();
  private flushTimer: NodeJS.Timeout | null = null;
  private deferred = new Map<string, NodeJS.Timeout>();
  private timers: NodeJS.Timeout[] = [];
  private wake: (() => void) | null = null;
  private stopped = false;
  private workerDone: Promise<void> | null = null;
  private changeLibs = new Set<string>();
  private changeRemoved: number[] = [];
  private changeCaptions = new Set<number>();
  private changeTimer: NodeJS.Timeout | null = null;
  /** Scans and watcher batches run one at a time, so DB reconciliation never interleaves. */
  private queue: Promise<void> = Promise.resolve();
  /** Item currently being indexed, for status display. */
  current: string | null = null;

  constructor(readonly cfg: AppConfig, readonly db: Db, readonly log: Logger) {
    super();
    for (const lib of cfg.libraries) {
      this.libs.set(lib.id, { cfg: lib, realRoot: null, rootDev: null, error: null, scanning: false, lastScanMs: null, watcher: null });
    }
  }

  get stableMs() {
    return this.cfg.scan.stableSeconds * 1000;
  }

  async start(opts: { watch?: boolean; worker?: boolean } = {}) {
    const { watch = true, worker = true } = opts;
    for (const state of this.libs.values()) {
      await this.openLibrary(state);
      if (watch) this.watch(state);
    }
    if (worker) this.workerDone = this.workerLoop();
    // Initial scans run in the background so the server can start serving immediately.
    void this.scanAll();
    if (this.cfg.scan.intervalMinutes > 0) {
      this.timers.push(setInterval(() => void this.scanAll(), this.cfg.scan.intervalMinutes * 60_000));
    }
    // Retry unavailable libraries (e.g. an unmounted disk) every minute.
    this.timers.push(setInterval(() => void this.retryUnavailable(watch), 60_000));
    this.timers.push(setInterval(() => this.purgeMissing(), 6 * 3600_000));
    for (const t of this.timers) t.unref();
  }

  async stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    for (const t of this.deferred.values()) clearTimeout(t);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.wake?.();
    await Promise.all([...this.libs.values()].map((s) => s.watcher?.close()));
    await this.workerDone;
    await this.queue.catch(() => {});
  }

  private async openLibrary(state: LibraryState): Promise<boolean> {
    try {
      const real = await fs.promises.realpath(state.cfg.path);
      const st = await fs.promises.stat(real);
      if (!st.isDirectory()) throw new Error('not a directory');
      await fs.promises.access(real, fs.constants.R_OK | fs.constants.X_OK);
      state.realRoot = real;
      state.rootDev = st.dev;
      state.error = null;
      return true;
    } catch (err) {
      this.setUnavailable(state, (err as NodeJS.ErrnoException).code ?? (err as Error).message);
      return false;
    }
  }

  /**
   * Takes a library offline: its rows are kept as they are, and the watcher is
   * closed so a fresh one is attached when the folder comes back (e.g. remount).
   */
  private setUnavailable(state: LibraryState, reason: string) {
    if (state.realRoot || !state.error) {
      this.log.warn({ library: state.cfg.id, path: state.cfg.path, err: reason }, 'library unavailable');
    }
    state.realRoot = null;
    state.rootDev = null;
    state.error = `Library folder is unavailable: ${reason}`;
    const w = state.watcher;
    state.watcher = null;
    void w?.close().catch(() => {});
  }

  /** False (and the library is taken offline) if its folder vanished or its filesystem was unmounted. */
  private async rootAlive(state: LibraryState): Promise<boolean> {
    if (!state.realRoot) return false;
    const st = await fs.promises.stat(state.realRoot).catch(() => null);
    if (st?.isDirectory() && st.dev === state.rootDev) return true;
    this.setUnavailable(state, st ? 'filesystem changed (unmounted?)' : 'ENOENT');
    this.notify(state.cfg.id);
    return false;
  }

  private async retryUnavailable(watch: boolean) {
    for (const state of this.libs.values()) {
      if (state.realRoot) continue;
      if (await this.openLibrary(state)) {
        this.log.info({ library: state.cfg.id }, 'library became available');
        this.kick();
        if (watch) this.watch(state);
        void this.scanLibrary(state.cfg.id);
      }
    }
  }

  // --- Scanning -------------------------------------------------------------

  scanAll(): Promise<void> {
    return Promise.all([...this.libs.keys()].map((id) => this.scanLibrary(id))).then(() => {});
  }

  /** Full scan of one library. */
  scanLibrary(id: string): Promise<void> {
    return this.enqueue(`scan ${id}`, () => this.doScan(id));
  }

  /** Runs `fn` exclusively with respect to scans and watcher batches, propagating its result. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.then(() => {}, () => {});
    return run;
  }

  /** Runs reconciliation work strictly one job at a time; failures are logged, never thrown. */
  private enqueue(what: string, job: () => Promise<void>): Promise<void> {
    const next = this.queue.then(job).catch((err) => {
      this.log.error({ job: what, err: (err as Error).message }, 'index job failed');
    });
    this.queue = next;
    return next;
  }

  private async doScan(id: string) {
    const state = this.libs.get(id);
    if (!state || this.stopped) return;
    if (!state.realRoot && !(await this.openLibrary(state))) return;
    // The root may have vanished (or been unmounted) since it was opened.
    if (!(await this.rootAlive(state))) return;
    state.scanning = true;
    const started = Date.now();
    try {
      const { files, sidecars, failedDirs } = await walkLibrary(state.cfg, state.realRoot!);
      // Unmounted mid-walk: the listing is incomplete, so reconcile nothing.
      if (!(await this.rootAlive(state))) return;
      const rows = this.db.all<Pick<AssetRow, 'id' | 'rel_path' | 'size' | 'mtime_ms' | 'inode' | 'birth_ms'>>(
        "SELECT id, rel_path, size, mtime_ms, inode, birth_ms FROM assets WHERE library_id = ? AND status = 'ready'", id,
      );
      const onDisk = new Map(files.map((f) => [f.rel, f]));
      const unreadable = (rel: string) => failedDirs.some((d) => d === '' || rel === d || rel.startsWith(d + '/'));
      const removed: number[] = [];
      for (const row of rows) {
        if (onDisk.has(row.rel_path) || unreadable(row.rel_path)) continue;
        this.markMissing(row.id);
        removed.push(row.id);
      }
      const byPath = new Map(rows.map((r) => [r.rel_path, r]));
      let changed = removed.length > 0;
      for (const f of files) {
        if (this.stopped) return;
        const row = byPath.get(f.rel);
        if (row && row.size === f.size && row.mtime_ms === f.mtimeMs && sameFile(row, f)) continue;
        if ((await this.syncFile(state, f)) !== 'unchanged') changed = true;
      }
      const captions = await this.reconcileCaptions(id, sidecars, unreadable);
      if (failedDirs.length) {
        this.log.warn({ library: id, dirs: failedDirs.slice(0, 10) }, 'some folders could not be read');
      }
      if (changed || captions.length) this.notify(id, removed, captions);
      this.log.info({ library: id, files: files.length, ms: Date.now() - started }, 'scan complete');
    } finally {
      state.scanning = false;
      state.lastScanMs = Date.now();
    }
  }

  /**
   * Reconciles one file on disk with the database. Returns what happened.
   * Never touches the file itself (read-only access).
   */
  async syncFile(state: LibraryState, f: FileEntry): Promise<'unchanged' | 'deferred' | 'updated' | 'added' | 'moved' | 'error'> {
    const lib = state.cfg;
    const type = mediaType(f.rel);
    if (!type) return 'unchanged';
    const current = this.db.liveAt(lib.id, f.rel);
    if (current && current.size === f.size && current.mtime_ms === f.mtimeMs && sameFile(current, f)) return 'unchanged';

    const age = Date.now() - f.mtimeMs;
    if (age < this.stableMs) {
      this.defer(lib.id, f.rel, this.stableMs - age + 250);
      return 'deferred';
    }
    if (age < YOUNG_FILE_MS && !(await looksComplete(f.abs).catch(() => false))) {
      // Still being written (or truncated). Check again shortly; the age limit
      // above eventually lets a genuinely corrupt file through so it is shown.
      this.defer(lib.id, f.rel, Math.max(this.stableMs, 3000));
      return 'deferred';
    }

    let fp: string;
    try {
      fp = await fingerprint(f.abs);
    } catch (err) {
      this.log.warn({ library: lib.id, file: f.rel, err: (err as Error).message }, 'cannot read file');
      return 'error';
    }
    const now = Date.now();
    const name = path.posix.basename(f.rel);
    const folder = folderOf(f.rel);

    return this.db.tx(() => {
      // Re-read: the row may have changed while the file was being read.
      const live = this.db.liveAt(lib.id, f.rel);
      if (live) {
        if (live.fingerprint === fp) {
          this.db.run('UPDATE assets SET size = ?, mtime_ms = ?, inode = ?, birth_ms = ? WHERE id = ?',
            f.size, f.mtimeMs, f.ino, f.birthMs, live.id);
          return 'updated';
        }
        if (sameFile(live, f)) {
          // Same file modified in place: keep favorite/rating, re-read metadata and thumbnail.
          this.db.run(
            `UPDATE assets SET size = ?, mtime_ms = ?, fingerprint = ?, index_state = 'pending',
               index_error = NULL, thumb_error = NULL WHERE id = ?`,
            f.size, f.mtimeMs, fp, live.id,
          );
          this.kick();
          return 'updated';
        }
        // A different file now occupies this path: do not inherit the old one's rating.
        this.markMissing(live.id);
      }

      // Moved or renamed? Match a vanished asset with identical content.
      const moved = this.findMovedFrom(fp, f.size);
      if (moved) {
        this.db.run(
          `UPDATE assets SET library_id = ?, rel_path = ?, folder = ?, name = ?, kind = ?, size = ?, mtime_ms = ?,
             inode = ?, birth_ms = ?, status = 'ready', missing_since_ms = NULL WHERE id = ?`,
          lib.id, f.rel, folder, name, type.kind, f.size, f.mtimeMs, f.ino, f.birthMs, moved.id,
        );
        return 'moved';
      }
      this.db.run(
        `INSERT INTO assets (library_id, rel_path, folder, name, kind, size, mtime_ms, inode, birth_ms, fingerprint, first_seen_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        lib.id, f.rel, folder, name, type.kind, f.size, f.mtimeMs, f.ino, f.birthMs, fp, now,
      );
      this.kick();
      return 'added';
    });
  }

  // --- Caption sidecars -------------------------------------------------------

  /**
   * Re-reads the caption sidecars of every live asset whose cached size/mtime/inode
   * signatures differ from what the scan found on disk. Returns the changed asset ids.
   */
  private async reconcileCaptions(libId: string, sidecars: FileEntry[], unreadable: (rel: string) => boolean): Promise<number[]> {
    const onDisk = new Map(sidecars.map((f) => [f.rel, sigOf(f)]));
    const rows = this.db.all<CaptionOwner & Pick<CaptionRow, 'txt_sig' | 'json_sig'>>(
      `SELECT assets.id, library_id, rel_path, folder, name, txt_sig, json_sig FROM assets
         LEFT JOIN captions ON captions.asset_id = assets.id WHERE library_id = ? AND status = 'ready'`, libId);
    const changed: number[] = [];
    for (const row of rows) {
      if (this.stopped) break;
      if (unreadable(row.rel_path)) continue;
      const names = sidecarNames(row.name);
      const prefix = row.folder ? row.folder + '/' : '';
      if ((onDisk.get(prefix + names.txt) ?? null) === row.txt_sig && (onDisk.get(prefix + names.json) ?? null) === row.json_sig) continue;
      if (await this.syncCaption(row)) changed.push(row.id);
    }
    return changed;
  }

  /**
   * Refreshes the cached caption of one asset from its sidecars. Cheap when nothing
   * changed (two stats), so it is safe to call after the gallery's own writes.
   * Returns true if the cache changed.
   */
  async syncCaption(row: CaptionOwner): Promise<boolean> {
    const state = this.libs.get(row.library_id);
    if (!state?.realRoot) return false;
    const names = sidecarNames(row.name);
    const prefix = row.folder ? row.folder + '/' : '';
    const [t, j] = await Promise.all([statEntry(state.realRoot, prefix + names.txt), statEntry(state.realRoot, prefix + names.json)]);
    const txtSig = sigOf(t);
    const jsonSig = sigOf(j);
    const cur = this.db.caption(row.id);
    if (cur ? cur.txt_sig === txtSig && cur.json_sig === jsonSig : !txtSig && !jsonSig) return false;
    if (!t && !j) {
      this.db.run('DELETE FROM captions WHERE asset_id = ?', row.id);
      return true;
    }
    let s;
    try {
      s = await readSidecars(path.dirname((t ?? j)!.abs), row.name);
    } catch (err) {
      this.log.warn({ file: row.rel_path, err: (err as Error).message }, 'cannot read caption sidecar');
      return false;
    }
    // Only files that statEntry accepted (e.g. no symlinks out of the library).
    if (!t) s.txt = s.txtSha256 = null;
    if (!j) s.json = null;
    if (s.txt === null && !s.json && !s.jsonError) {
      // e.g. symlinked sidecars, which are never read.
      this.db.run('DELETE FROM captions WHERE asset_id = ?', row.id);
      return !!cur;
    }
    const json = s.json;
    const classification = json?.classification && typeof json.classification === 'object' ? JSON.stringify(json.classification) : null;
    this.db.run(
      `INSERT INTO captions (asset_id, caption, caption_status, txt_sha256, has_candidate, json_updated_at, classification_json, txt_sig, json_sig)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(asset_id) DO UPDATE SET caption = excluded.caption, caption_status = excluded.caption_status,
         txt_sha256 = excluded.txt_sha256, has_candidate = excluded.has_candidate, json_updated_at = excluded.json_updated_at,
         classification_json = excluded.classification_json, txt_sig = excluded.txt_sig, json_sig = excluded.json_sig, rev = rev + 1`,
      row.id, s.txt, effectiveStatus(s) ?? 'unknown', s.txtSha256, hasCandidate(json) ? 1 : 0,
      typeof json?.updated_at === 'string' ? json.updated_at : null, classification, txtSig, jsonSig,
    );
    return true;
  }

  /** A missing asset with the same content, or a live one whose file is gone (event ordering). */
  private findMovedFrom(fp: string, size: number): AssetRow | undefined {
    const missing = this.db.missingMatch(fp, size);
    if (missing) return missing;
    // Bounded: libraries can hold many identical files, and this runs for every new file.
    const live = this.db.all<AssetRow>(
      "SELECT * FROM assets WHERE status = 'ready' AND fingerprint = ? AND size = ? ORDER BY id DESC LIMIT 8", fp, size);
    for (const row of live) {
      const state = this.libs.get(row.library_id);
      if (!state?.realRoot) continue;
      if (!fs.existsSync(path.join(state.realRoot, ...row.rel_path.split('/')))) {
        this.markMissing(row.id);
        return { ...row, status: 'missing' };
      }
    }
    return undefined;
  }

  private markMissing(id: number) {
    const r = this.db.run("UPDATE assets SET status = 'missing', missing_since_ms = ? WHERE id = ? AND status = 'ready'", Date.now(), id);
    if (Number(r.changes) > 0) this.adoptIntoCopy(id);
  }

  /**
   * Copy-then-delete moves (rsync, cross-disk mv) create the new file before the
   * old one disappears, so the new copy was indexed as a fresh, unrated asset.
   * When the old file goes missing, hand its favorite/rating to an identical
   * copy that appeared recently and has not been organised yet.
   */
  private adoptIntoCopy(missingId: number) {
    const gone = this.db.asset(missingId);
    if (!gone || (!gone.favorite && !gone.rating)) return;
    const copy = this.db.get<AssetRow>(
      `SELECT * FROM assets WHERE status = 'ready' AND fingerprint = ? AND size = ? AND favorite = 0 AND rating = 0
         AND first_seen_ms >= ? ORDER BY first_seen_ms DESC LIMIT 1`,
      gone.fingerprint, gone.size, Date.now() - ADOPT_WINDOW_MS,
    );
    if (!copy) return;
    this.db.run('UPDATE assets SET favorite = ?, rating = ? WHERE id = ?', gone.favorite, gone.rating, copy.id);
    this.db.run('UPDATE assets SET favorite = 0, rating = 0 WHERE id = ?', gone.id);
  }

  purgeMissing() {
    const cutoff = Date.now() - MISSING_RETENTION_MS;
    const r = this.db.run("DELETE FROM assets WHERE status = 'missing' AND missing_since_ms < ?", cutoff);
    if (Number(r.changes) > 0) this.log.info({ count: r.changes }, 'purged long-missing assets');
  }

  private defer(libId: string, rel: string, ms: number) {
    const key = `${libId}\0${rel}`;
    if (this.deferred.has(key) || this.stopped) return;
    const t = setTimeout(() => {
      this.deferred.delete(key);
      this.queuePath(libId, rel);
    }, ms);
    t.unref();
    this.deferred.set(key, t);
  }

  // --- Watching ------------------------------------------------------------

  private watch(state: LibraryState) {
    if (!state.realRoot || state.watcher) return;
    const root = state.realRoot;
    const watcher = chokidar.watch(root, {
      ignoreInitial: true,
      followSymlinks: false,
      depth: state.cfg.recursive ? undefined : 0,
      usePolling: this.cfg.scan.usePolling,
      interval: 5000,
      binaryInterval: 5000,
      ignored: (p: string, stats?: fs.Stats) => {
        if (p === root) return false;
        const rel = path.relative(root, p);
        if (rel.split(path.sep).some(isIgnoredName)) return true;
        return !!stats?.isFile() && !mediaType(p) && !sidecarStem(path.basename(p));
      },
    });
    const onFile = (p: string) => this.queuePath(state.cfg.id, toPosix(path.relative(root, p)));
    const onDir = () => this.queueScan(state.cfg.id);
    watcher.on('add', onFile).on('change', onFile).on('unlink', onFile);
    watcher.on('addDir', onDir).on('unlinkDir', onDir);
    watcher.on('error', (err) => this.log.warn({ library: state.cfg.id, err: (err as Error).message }, 'watcher error'));
    state.watcher = watcher;
  }

  queuePath(libId: string, rel: string) {
    try {
      checkRelPath(rel);
    } catch {
      return;
    }
    let set = this.pendingPaths.get(libId);
    if (!set) this.pendingPaths.set(libId, (set = new Set()));
    set.add(rel);
    this.scheduleFlush();
  }

  private queueScan(libId: string) {
    this.pendingScans.add(libId);
    this.scheduleFlush();
  }

  /** Debounces bursts of watcher events into one batch. */
  private scheduleFlush() {
    if (this.flushTimer || this.stopped) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.enqueue('watch batch', () => this.flush());
    }, WATCH_DEBOUNCE_MS);
  }

  private async flush() {
    const scans = [...this.pendingScans];
    this.pendingScans.clear();
    const batches = [...this.pendingPaths];
    this.pendingPaths.clear();
    for (const id of scans) await this.doScan(id);
    for (const [libId, rels] of batches) {
      if (scans.includes(libId)) continue;
      const state = this.libs.get(libId);
      // An unmount shows up as a burst of deletions; never act on those.
      if (!state || !(await this.rootAlive(state))) continue;
      const removed: number[] = [];
      const present: FileEntry[] = [];
      const sidecarRels: string[] = [];
      // Removals first, so a rename in the same batch is matched as a move.
      for (const rel of rels) {
        if (!mediaType(rel)) {
          sidecarRels.push(rel);
          continue;
        }
        const entry = await statEntry(state.realRoot!, rel);
        if (entry) {
          present.push(entry);
          continue;
        }
        const row = this.db.liveAt(libId, rel);
        if (row) {
          this.markMissing(row.id);
          removed.push(row.id);
        }
      }
      let changed = removed.length > 0;
      for (const entry of present) {
        const r = await this.syncFile(state, entry);
        if (r !== 'unchanged' && r !== 'deferred' && r !== 'error') changed = true;
      }
      // Captions of touched media files (new, moved) and of the owners of touched sidecars.
      const owners = new Map<number, CaptionOwner>();
      for (const entry of present) {
        const row = this.db.liveAt(libId, entry.rel);
        if (row) owners.set(row.id, row);
      }
      for (const rel of sidecarRels) {
        const stem = sidecarStem(path.posix.basename(rel));
        if (stem) for (const row of this.db.liveWithStem(libId, folderOf(rel), stem)) owners.set(row.id, row);
      }
      const captions: number[] = [];
      for (const row of owners.values()) if (await this.syncCaption(row)) captions.push(row.id);
      if (changed || captions.length) this.notify(libId, removed, captions);
    }
  }

  // --- Change notifications ------------------------------------------------

  notify(libId: string, removed: number[] = [], captions: number[] = []) {
    this.changeLibs.add(libId);
    this.changeRemoved.push(...removed);
    for (const id of captions) this.changeCaptions.add(id);
    if (this.changeTimer) return;
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      const ev: ChangeEvent = {
        libraries: [...this.changeLibs], removed: this.changeRemoved.slice(0, 1000), captions: [...this.changeCaptions].slice(0, 1000),
      };
      this.changeLibs.clear();
      this.changeRemoved = [];
      this.changeCaptions.clear();
      this.emit('change', ev);
    }, 500);
  }

  // --- Background metadata + thumbnail worker -------------------------------

  /** Wakes the worker after new work is queued. */
  kick() {
    this.wake?.();
  }

  pendingCount(): number {
    return this.db.get<{ n: number }>("SELECT count(*) AS n FROM assets WHERE status = 'ready' AND index_state = 'pending'")!.n;
  }

  absPath(row: Pick<AssetRow, 'library_id' | 'rel_path'>): string | null {
    const state = this.libs.get(row.library_id);
    if (!state?.realRoot) return null;
    const abs = path.join(state.realRoot, ...row.rel_path.split('/'));
    return isInside(state.realRoot, abs) ? abs : null;
  }

  private async workerLoop() {
    const cpus = os.availableParallelism();
    while (!this.stopped) {
      // Only libraries that are currently reachable; others wait until they come back.
      const online = [...this.libs.values()].filter((l) => l.realRoot).map((l) => l.cfg.id);
      const row = online.length ? this.db.get<AssetRow>(
        `SELECT * FROM assets WHERE status = 'ready' AND index_state = 'pending'
           AND library_id IN (${online.map(() => '?').join(',')}) ORDER BY mtime_ms DESC, id DESC LIMIT 1`,
        ...online,
      ) : undefined;
      if (!row) {
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
        this.wake = null;
        continue;
      }
      await this.indexOne(row);
      // Be polite to ComfyUI: back off when the machine is busy.
      await sleep(os.loadavg()[0] > cpus * 0.75 ? 1500 : 20);
    }
  }

  /** Extracts metadata and makes a thumbnail. Returns false if the asset could not be reached. */
  async indexOne(row: AssetRow): Promise<boolean> {
    const abs = this.absPath(row);
    if (!abs) return false; // library offline: stays pending until it is back
    this.current = row.rel_path;
    try {
      const x = await extract(abs, row.kind, { ffprobe: this.cfg.tools.ffprobe });
      this.db.tx(() => {
        // Only apply if the row was not changed meanwhile (e.g. file replaced).
        const r = this.db.run(
          `UPDATE assets SET width = ?, height = ?, duration = ?, video_codec = ?, audio_codec = ?, animated = ?,
             has_gen_meta = ?, index_state = 'done', index_error = NULL WHERE id = ? AND fingerprint = ?`,
          x.width, x.height, x.duration, x.videoCodec, x.audioCodec, x.animated ? 1 : 0,
          x.promptJson || x.workflowJson || x.parameters ? 1 : 0, row.id, row.fingerprint,
        );
        if (Number(r.changes) === 0) return;
        this.db.run(
          `INSERT INTO metadata (asset_id, prompt_json, workflow_json, parameters, extra_json, summary_json, search_text)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(asset_id) DO UPDATE SET prompt_json = excluded.prompt_json, workflow_json = excluded.workflow_json,
             parameters = excluded.parameters, extra_json = excluded.extra_json, summary_json = excluded.summary_json,
             search_text = excluded.search_text`,
          row.id, x.promptJson, x.workflowJson, x.parameters,
          Object.keys(x.extra).length ? JSON.stringify(x.extra) : null,
          x.summary ? JSON.stringify(x.summary) : null, x.searchText || null,
        );
      });
    } catch (err) {
      const msg = (err as Error).message.slice(0, 500);
      this.log.warn({ file: row.rel_path, err: msg }, 'metadata extraction failed');
      this.db.run("UPDATE assets SET index_state = 'error', index_error = ? WHERE id = ? AND fingerprint = ?", msg, row.id, row.fingerprint);
    }
    try {
      await ensureThumb(abs, row.kind, row.fingerprint, this.thumbOptions());
    } catch (err) {
      this.db.run('UPDATE assets SET thumb_error = ? WHERE id = ?', (err as Error).message.slice(0, 500), row.id);
    }
    this.current = null;
    return true;
  }

  thumbOptions() {
    return {
      cacheDir: this.cfg.cacheDir,
      size: this.cfg.thumbnails.size,
      quality: this.cfg.thumbnails.quality,
      ffmpeg: this.cfg.tools.ffmpeg,
    };
  }
}
