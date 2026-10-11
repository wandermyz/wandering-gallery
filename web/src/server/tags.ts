import type { Db } from './db.js';
import { HttpError } from './paths.js';

/**
 * User tags on assets. They live only in SQLite (never in the files) and are
 * matched case-insensitively; a tag keeps the spelling it was created with.
 */

export interface TagInfo {
  id: number;
  name: string;
  /** Live assets with this tag. */
  count: number;
  /** Newest live asset with this tag, for a cover thumbnail. */
  cover: { id: number; v: string } | null;
  /** Only listed while unlocked. */
  hidden: boolean;
}

export const TAG_MAX = 64;

/** Trims and collapses whitespace; rejects empty, overlong and control-character names. */
export function checkTagName(v: unknown): string {
  if (typeof v !== 'string') throw new HttpError('tag must be a string', 400);
  const name = v.trim().replace(/\s+/g, ' ');
  if (!name) throw new HttpError('Tag names cannot be empty', 400);
  if (name.length > TAG_MAX) throw new HttpError(`Tag names can be at most ${TAG_MAX} characters`, 400);
  if (/[\x00-\x1f\x7f]/.test(name)) throw new HttpError('Tag names cannot contain control characters', 400);
  return name;
}

function nameList(v: unknown, field: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 100) throw new HttpError(`${field} must be a list of tag names`, 400);
  return v.map(checkTagName);
}

export class Tags {
  constructor(readonly db: Db) {}

  /**
   * `countable` and `coverable` are SQL conditions on `assets` (for hidden items: what
   * this browser may count, and what may be a cover). Hidden tags only with `withHidden`.
   */
  list(countable = '1', coverable = '1', withHidden = true): TagInfo[] {
    const cover = (alias: string) => coverable.replaceAll('assets.', `${alias}.`);
    const rows = this.db.all<{ id: number; name: string; hidden: number; n: number; cover_id: number | null; cover_fp: string | null }>(
      `SELECT tags.id, tags.name, tags.hidden, count(a.id) AS n,
         (SELECT c.id FROM asset_tags ct JOIN assets c ON c.id = ct.asset_id
          WHERE ct.tag_id = tags.id AND c.status = 'ready' AND ${cover('c')} ORDER BY c.mtime_ms DESC, c.id DESC LIMIT 1) AS cover_id,
         (SELECT c.fingerprint FROM asset_tags ct JOIN assets c ON c.id = ct.asset_id
          WHERE ct.tag_id = tags.id AND c.status = 'ready' AND ${cover('c')} ORDER BY c.mtime_ms DESC, c.id DESC LIMIT 1) AS cover_fp
       FROM tags
       LEFT JOIN asset_tags at ON at.tag_id = tags.id
       LEFT JOIN assets a ON a.id = at.asset_id AND a.status = 'ready' AND ${countable.replaceAll('assets.', 'a.')}
       ${withHidden ? '' : 'WHERE tags.hidden = 0'}
       GROUP BY tags.id
       ORDER BY tags.name COLLATE NOCASE`,
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      count: r.n,
      cover: r.cover_id && r.cover_fp ? { id: r.cover_id, v: r.cover_fp.slice(0, 12) } : null,
      hidden: !!r.hidden,
    }));
  }

  /** Lower-cased names of hidden tags, to strip from assets shown to a locked browser. */
  hiddenNames(): Set<string> {
    return new Set(this.db.all<{ name: string }>('SELECT name FROM tags WHERE hidden = 1').map((r) => r.name.toLowerCase()));
  }

  isHidden(id: number): boolean {
    return !!this.db.get<{ hidden: number }>('SELECT hidden FROM tags WHERE id = ?', id)?.hidden;
  }

  setHidden(id: number, hidden: boolean) {
    const r = this.db.run('UPDATE tags SET hidden = ? WHERE id = ?', hidden ? 1 : 0, id);
    if (!r.changes) throw new HttpError('tag not found', 404);
  }

  /** Adds and removes tags on one asset; unknown names in `add` create new tags. */
  update(assetId: number, body: { add?: unknown; remove?: unknown }) {
    const add = nameList(body.add, 'add');
    const remove = nameList(body.remove, 'remove');
    if (!add.length && !remove.length) throw new HttpError('nothing to change', 400);
    const now = Date.now();
    this.db.tx(() => {
      for (const name of remove) {
        this.db.run(
          'DELETE FROM asset_tags WHERE asset_id = ? AND tag_id = (SELECT id FROM tags WHERE name = ?)',
          assetId, name,
        );
      }
      for (const name of add) {
        this.db.run('INSERT INTO tags (name, created_ms) VALUES (?, ?) ON CONFLICT(name) DO NOTHING', name, now);
        this.db.run(
          'INSERT OR IGNORE INTO asset_tags (asset_id, tag_id) SELECT ?, id FROM tags WHERE name = ?',
          assetId, name,
        );
      }
    });
  }

  rename(id: number, to: unknown) {
    const name = checkTagName(to);
    const tag = this.db.get<{ id: number; name: string }>('SELECT id, name FROM tags WHERE id = ?', id);
    if (!tag) throw new HttpError('tag not found', 404);
    const other = this.db.get<{ id: number }>('SELECT id FROM tags WHERE name = ? AND id != ?', name, id);
    this.db.tx(() => {
      if (other) {
        // Renaming onto an existing tag merges the two.
        this.db.run('INSERT OR IGNORE INTO asset_tags (asset_id, tag_id) SELECT asset_id, ? FROM asset_tags WHERE tag_id = ?', other.id, id);
        this.db.run('DELETE FROM tags WHERE id = ?', id);
        this.db.run('UPDATE tags SET name = ? WHERE id = ?', name, other.id);
      } else {
        this.db.run('UPDATE tags SET name = ? WHERE id = ?', name, id);
      }
    });
    return { id: other?.id ?? id, name, merged: !!other };
  }

  delete(id: number) {
    const r = this.db.run('DELETE FROM tags WHERE id = ?', id);
    if (!r.changes) throw new HttpError('tag not found', 404);
  }
}
