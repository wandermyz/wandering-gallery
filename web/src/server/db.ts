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
  hidden: number;
  first_seen_ms: number;
  missing_since_ms: number | null;
  trashed_at_ms: number | null;
  trash_path: string | null;
  /** From the captions table, where the query joins it (see Db.asset). */
  caption_status?: string | null;
  has_candidate?: number | null;
  caption_rev?: number | null;
  /** Tag names joined with TAG_SEP (see CAPTION_JOIN). */
  tag_names?: string | null;
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

export interface CaptionRow {
  asset_id: number;
  caption: string | null;
  caption_status: string;
  txt_sha256: string | null;
  has_candidate: number;
  json_updated_at: string | null;
  classification_json: string | null;
  txt_sig: string | null;
  json_sig: string | null;
  rev: number;
}

/** Separates tag names in `tag_names`; tag names cannot contain control characters. */
export const TAG_SEP = '\x1f';

/** Caption columns and tag names joined onto asset rows for the browser. */
export const CAPTION_JOIN = `SELECT assets.*, captions.caption_status, captions.has_candidate, captions.rev AS caption_rev,
  (SELECT group_concat(name, char(31)) FROM (SELECT tags.name FROM asset_tags JOIN tags ON tags.id = asset_tags.tag_id
    WHERE asset_tags.asset_id = assets.id ORDER BY tags.name COLLATE NOCASE)) AS tag_names
  FROM assets LEFT JOIN captions ON captions.asset_id = assets.id`;

const SCHEMA_VERSION = 5;

const MIGRATIONS: (string | ((sql: DatabaseSync) => void))[] = [
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
  // Cache of caption sidecars (<stem>.txt + <stem>.caption.json). The files are the
  // source of truth; rows are rebuilt whenever a file's size/mtime/inode signature changes.
  `
  CREATE TABLE captions (
    asset_id INTEGER PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
    caption TEXT,
    caption_status TEXT NOT NULL,
    txt_sha256 TEXT,
    has_candidate INTEGER NOT NULL DEFAULT 0,
    json_updated_at TEXT,
    classification_json TEXT,
    txt_sig TEXT,
    json_sig TEXT,
    rev INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX captions_status ON captions(caption_status);
  `,
  // Status rules changed (a .txt edited after approval reads as edited): drop the
  // signatures so the next scan re-reads every caption.
  `
  UPDATE captions SET txt_sig = NULL, json_sig = NULL;
  `,
  // User tags. Stored only here, never in the files; they follow the asset row (renames,
  // trash and restore) and go away with it.
  `
  CREATE TABLE tags (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    created_ms INTEGER NOT NULL
  );
  CREATE TABLE asset_tags (
    asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (asset_id, tag_id)
  ) WITHOUT ROWID;
  CREATE INDEX asset_tags_tag ON asset_tags(tag_id, asset_id);
  `,
  // Hidden assets: left out of every list unless the browser is unlocked.
  // Before its rebase onto tags, the hidden-items branch shipped this as v4, so a
  // v4 database may have the column but not the tags tables: repair either way.
  (sql) => {
    const cols = sql.prepare('PRAGMA table_info(assets)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'hidden')) sql.exec('ALTER TABLE assets ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0');
    if (!sql.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tags'").get()) sql.exec(MIGRATIONS[3] as string);
  },
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
        const m = MIGRATIONS[v];
        if (typeof m === 'string') this.sql.exec(m);
        else m(this.sql);
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
    return this.get<AssetRow>(`${CAPTION_JOIN} WHERE assets.id = ?`, id);
  }

  /** Live assets in `folder` whose name is `<stem>.<ext>` (the owners of that stem's caption sidecars). */
  liveWithStem(libraryId: string, folder: string, stem: string): AssetRow[] {
    // '/' sorts right after '.', so [stem + '.', stem + '/') covers names starting with "stem.".
    return this.all<AssetRow>(
      "SELECT * FROM assets WHERE status = 'ready' AND library_id = ? AND folder = ? AND name >= ? AND name < ?",
      libraryId, folder, stem + '.', stem + '/',
    ).filter((r) => r.name.slice(0, r.name.lastIndexOf('.')) === stem);
  }

  caption(id: number): CaptionRow | undefined {
    return this.get<CaptionRow>('SELECT * FROM captions WHERE asset_id = ?', id);
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

  setHidden(id: number, hidden: boolean) {
    this.run('UPDATE assets SET hidden = ? WHERE id = ?', hidden ? 1 : 0, id);
  }

  setRating(id: number, rating: number) {
    this.run('UPDATE assets SET rating = ? WHERE id = ?', rating, id);
  }

  metadata(id: number): MetadataRow | undefined {
    return this.get<MetadataRow>('SELECT * FROM metadata WHERE asset_id = ?', id);
  }
}
