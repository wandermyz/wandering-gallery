import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export type AssetStatus = 'ready' | 'missing' | 'trashed';

export interface AssetRow {
  id: number;
  library_id: string;
  rel_path: string;
  folder: string;
  name: string;
  kind: 'image' | 'video';
  size: number;
  mtime_ms: number;
  inode: number;
  birth_ms: number;
  fingerprint: string;
  width: number | null;
  height: number | null;
  duration: number | null;
  video_codec: string | null;
  audio_codec: string | null;
  animated: number;
  has_gen_meta: number;
  index_state: 'pending' | 'done' | 'error';
  index_error: string | null;
  thumb_error: string | null;
  status: AssetStatus;
  favorite: number;
  rating: number;
  first_seen_ms: number;
  missing_since_ms: number | null;
  trashed_at_ms: number | null;
  trash_path: string | null;
}

export interface MetadataRow {
  asset_id: number;
  prompt_json: string | null;
  workflow_json: string | null;
  parameters: string | null;
  extra_json: string | null;
  summary_json: string | null;
  search_text: string | null;
}

const SCHEMA_VERSION = 1;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE assets (
    id INTEGER PRIMARY KEY,
    library_id TEXT NOT NULL,
    rel_path TEXT NOT NULL,
    folder TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    size INTEGER NOT NULL,
    mtime_ms INTEGER NOT NULL,
    inode INTEGER NOT NULL DEFAULT 0,
    birth_ms INTEGER NOT NULL DEFAULT 0,
    fingerprint TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    duration REAL,
    video_codec TEXT,
    audio_codec TEXT,
    animated INTEGER NOT NULL DEFAULT 0,
    has_gen_meta INTEGER NOT NULL DEFAULT 0,
    index_state TEXT NOT NULL DEFAULT 'pending',
    index_error TEXT,
    thumb_error TEXT,
    status TEXT NOT NULL DEFAULT 'ready',
    favorite INTEGER NOT NULL DEFAULT 0,
    rating INTEGER NOT NULL DEFAULT 0,
    first_seen_ms INTEGER NOT NULL,
    missing_since_ms INTEGER,
    trashed_at_ms INTEGER,
    trash_path TEXT
  );
  -- Only one live asset per path; missing/trashed rows keep their old path for restore/matching.
  CREATE UNIQUE INDEX assets_live_path ON assets(library_id, rel_path) WHERE status = 'ready';
  CREATE INDEX assets_browse ON assets(status, library_id, folder, mtime_ms DESC, id DESC);
  CREATE INDEX assets_lib_time ON assets(status, library_id, mtime_ms DESC, id DESC);
  CREATE INDEX assets_time ON assets(status, mtime_ms DESC, id DESC);
  CREATE INDEX assets_fav ON assets(status, favorite, mtime_ms DESC) WHERE favorite = 1;
  CREATE INDEX assets_fingerprint ON assets(fingerprint, size);
  CREATE INDEX assets_pending ON assets(index_state) WHERE index_state = 'pending';

  CREATE TABLE metadata (
    asset_id INTEGER PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
    prompt_json TEXT,
    workflow_json TEXT,
    parameters TEXT,
    extra_json TEXT,
    summary_json TEXT,
    search_text TEXT
  );

  CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
];

export class Db {
  readonly sql: DatabaseSync;

  constructor(file: string) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.sql = new DatabaseSync(file);
    this.sql.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA temp_store = MEMORY;
    `);
    this.migrate();
  }

  private migrate() {
    const current = (this.sql.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (current > SCHEMA_VERSION) {
      throw new Error(`database schema v${current} is newer than this app (v${SCHEMA_VERSION})`);
    }
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        this.sql.exec(MIGRATIONS[v]);
        this.sql.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  tx<T>(fn: () => T): T {
    this.sql.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.sql.exec('COMMIT');
      return out;
    } catch (err) {
      this.sql.exec('ROLLBACK');
      throw err;
    }
  }

  get<T>(query: string, ...params: SQLInputValue[]): T | undefined {
    return this.sql.prepare(query).get(...params) as T | undefined;
  }

  all<T>(query: string, ...params: SQLInputValue[]): T[] {
    return this.sql.prepare(query).all(...params) as T[];
  }

  run(query: string, ...params: SQLInputValue[]) {
    return this.sql.prepare(query).run(...params);
  }

  close() {
    this.sql.close();
  }

  // --- Asset helpers ------------------------------------------------------

  asset(id: number): AssetRow | undefined {
    return this.get<AssetRow>('SELECT * FROM assets WHERE id = ?', id);
  }

  liveAt(libraryId: string, relPath: string): AssetRow | undefined {
    return this.get<AssetRow>(
      "SELECT * FROM assets WHERE library_id = ? AND rel_path = ? AND status = 'ready'",
      libraryId, relPath,
    );
  }

  /** A previously-seen asset that disappeared and whose content now shows up elsewhere. */
  missingMatch(fingerprint: string, size: number): AssetRow | undefined {
    return this.get<AssetRow>(
      "SELECT * FROM assets WHERE status = 'missing' AND fingerprint = ? AND size = ? ORDER BY missing_since_ms DESC LIMIT 1",
      fingerprint, size,
    );
  }

  setFavorite(id: number, favorite: boolean) {
    this.run('UPDATE assets SET favorite = ? WHERE id = ?', favorite ? 1 : 0, id);
  }

  setRating(id: number, rating: number) {
    this.run('UPDATE assets SET rating = ? WHERE id = ?', rating, id);
  }

  metadata(id: number): MetadataRow | undefined {
    return this.get<MetadataRow>('SELECT * FROM metadata WHERE asset_id = ?', id);
  }
}
