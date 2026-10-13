import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { AppConfig } from './config.js';
import { Captions, CAPTION_STATUSES, parseCaptionRequest } from './captions.js';
import { CAPTION_JOIN, TAG_SEP, type AssetRow, type Db } from './db.js';
import { registerGenerate, type GenerateDeps } from './generate/routes.js';
import type { ChangeEvent, Indexer } from './indexer.js';
import { videoPlayability, mediaType } from './media.js';
import { unquoteJsonString, type GenerationSummary } from './metadata/comfyui.js';
import { checkFolder, HttpError, isInside, resolveInside } from './paths.js';
import { checkTagName, Tags } from './tags.js';
import { ensurePreview, ensureThumb } from './thumbs.js';
import { Trash } from './trash.js';
import { Unlock } from './unlock.js';

export interface AppDeps {
  cfg: AppConfig;
  db: Db;
  indexer: Indexer;
  trash: Trash;
  webRoot?: string | null;
  /** A pino logger instance, or false to disable request logging. */
  logger?: FastifyBaseLogger | false;
  /** ComfyUI, tagger and GPU access for the generate flows (tests pass fakes). */
  generate?: GenerateDeps;
}

const PAGE_MAX = 500;
/** Images above this many pixels (or bytes) get a resized preview in the viewer. */
const PREVIEW_PIXELS = 3000 * 3000;
const PREVIEW_BYTES = 15 * 1024 * 1024;

/** Public shape of an asset sent to the browser. */
function assetJson(r: AssetRow, hiddenLibs: ReadonlySet<string>, libPaths: ReadonlyMap<string, string>) {
  const root = libPaths.get(r.library_id);
  return {
    id: r.id,
    library: r.library_id,
    path: r.rel_path,
    /** Absolute path on the server, to paste into a generate flow. */
    filePath: root ? path.join(root, ...r.rel_path.split('/')) : null,
    folder: r.folder,
    name: r.name,
    kind: r.kind,
    mime: mediaType(r.name)?.mime ?? 'application/octet-stream',
    size: r.size,
    mtimeMs: r.mtime_ms,
    width: r.width,
    height: r.height,
    duration: r.duration,
    videoCodec: r.video_codec,
    audioCodec: r.audio_codec,
    playable: r.kind === 'video' ? videoPlayability(r.video_codec) : 'yes',
    animated: !!r.animated,
    hasMeta: !!r.has_gen_meta,
    indexState: r.index_state,
    indexError: r.index_error,
    favorite: !!r.favorite,
    rating: r.rating,
    hidden: !!r.hidden,
    libraryHidden: hiddenLibs.has(r.library_id),
    status: r.status,
    trashedAtMs: r.trashed_at_ms,
    caption: (r.caption_status ?? null) as string | null,
    captionCandidate: !!r.has_candidate,
    captionRev: r.caption_rev ?? 0,
    tags: r.tag_names ? r.tag_names.split(TAG_SEP) : [],
    // Thumbnail URLs embed the fingerprint so browsers can cache them forever. Hiding
    // changes the URL, so a hidden asset never reuses a long-lived cache entry.
    v: r.fingerprint.slice(0, 12) + (r.hidden || hiddenLibs.has(r.library_id) ? 'h' : ''),
    needsPreview: r.kind === 'image' && !r.animated &&
      ((r.width ?? 0) * (r.height ?? 0) > PREVIEW_PIXELS || r.size > PREVIEW_BYTES || r.name.toLowerCase().endsWith('.avif')),
  };
}

function intParam(v: unknown, name: string, min: number, max: number, fallback?: number): number {
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new HttpError(`${name} is required`, 400);
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(`${name} must be an integer ${min}-${max}`, 400);
  return n;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { cfg, db, indexer, trash } = deps;
  const captions = new Captions(db, indexer);
  const tags = new Tags(db);
  const app = Fastify({
    ...(deps.logger ? { loggerInstance: deps.logger } : { logger: false }),
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 64 * 1024,
    trustProxy: '127.0.0.1',
  });

  // ---- Request protection ------------------------------------------------
  // The server binds to localhost and is reached through Tailscale Serve.
  // Host allowlisting blocks DNS-rebinding; state-changing requests also need
  // a same-origin Origin and a CSRF token readable only by same-origin pages.
  const csrfToken = crypto.randomBytes(24).toString('base64url');
  const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', ...cfg.server.allowedHosts]);
  const hostOk = (host: string | undefined) => {
    if (!host) return false;
    const name = host.toLowerCase().replace(/:\d+$/, '');
    return allowedHosts.has(name);
  };

  app.addHook('onRequest', async (req, reply) => {
    if (!hostOk(req.headers.host)) {
      return reply.code(421).type('text/plain').send('Host not allowed. Add it to server.allowedHosts in the config.');
    }
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('X-Frame-Options', 'DENY');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin) {
        let originHost = '';
        try {
          originHost = new URL(origin).host;
        } catch {
          /* invalid */
        }
        const fwdHost = req.headers['x-forwarded-host'];
        const expected = [req.headers.host, ...(typeof fwdHost === 'string' ? [fwdHost] : [])];
        if (!expected.includes(originHost) && !hostOk(originHost)) {
          return reply.code(403).send({ error: 'cross-origin request rejected' });
        }
      }
      const token = req.headers['x-csrf-token'];
      if (typeof token !== 'string' || token.length !== csrfToken.length ||
          !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(csrfToken))) {
        return reply.code(403).send({ error: 'missing or invalid CSRF token; reload the page' });
      }
    }
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    // Never cache a refusal: a locked 404 must not outlive the lock.
    reply.header('Cache-Control', 'no-store');
    if (err instanceof HttpError) return reply.code(err.status).send({ ...err.data, error: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    req.log.error(err);
    return reply.code(500).send({ error: 'internal error' });
  });

  // ---- Hidden assets ---------------------------------------------------------
  // Hidden assets, and every asset of a hidden library, are left out of every list
  // and answer 404 everywhere, unless the browser holds a valid unlock cookie (see
  // unlock.ts). Hidden libraries are also left out of the library list.
  const unlock = new Unlock(cfg.hidden.passphraseHash, cfg.hidden.unlockMinutes * 60_000);
  const hiddenLibs: ReadonlySet<string> = new Set(cfg.libraries.filter((l) => l.hidden).map((l) => l.id));
  const libPaths: ReadonlyMap<string, string> = new Map(cfg.libraries.map((l) => [l.id, l.path]));
  const toJson = (req: FastifyRequest, r: AssetRow) => {
    const json = assetJson(r, hiddenLibs, libPaths);
    if (!json.tags.length || unlock.isUnlocked(req)) return json;
    const hiddenTags = tags.hiddenNames();
    return hiddenTags.size ? { ...json, tags: json.tags.filter((t) => !hiddenTags.has(t.toLowerCase())) } : json;
  };
  const isHidden = (r: Pick<AssetRow, 'hidden' | 'library_id'>) => !!r.hidden || hiddenLibs.has(r.library_id);
  // Library ids are config-validated ([a-z0-9_-]), so they are safe to inline.
  const notHidden = hiddenLibs.size
    ? `assets.hidden = 0 AND assets.library_id NOT IN (${[...hiddenLibs].map((id) => `'${id}'`).join(',')})`
    : 'assets.hidden = 0';
  /** SQL condition (on `assets`) for what this request may see. */
  const visible = (req: FastifyRequest) => (unlock.isUnlocked(req) ? '1' : notHidden);

  /** A library this request may see; hidden ones are unknown while locked. */
  const libState = (id: string, req: FastifyRequest | null) => {
    const s = indexer.libs.get(id);
    if (!s || (req && hiddenLibs.has(id) && !unlock.isUnlocked(req))) throw new HttpError('unknown library', 404);
    return s;
  };

  const getAsset = (req: FastifyRequest, statuses: string[] = ['ready']) => {
    const id = intParam((req.params as { id: string }).id, 'id', 1, Number.MAX_SAFE_INTEGER);
    const row = db.asset(id);
    if (!row || !statuses.includes(row.status) || (isHidden(row) && !unlock.isUnlocked(req))) throw new HttpError('asset not found', 404);
    return row;
  };

  /** For routes that look the asset up themselves: 404 for a hidden one while locked. */
  const visibleId = (req: FastifyRequest) => {
    const id = intParam((req.params as { id: string }).id, 'id', 1, Number.MAX_SAFE_INTEGER);
    const row = db.get<{ hidden: number; library_id: string }>('SELECT hidden, library_id FROM assets WHERE id = ?', id);
    if (row && isHidden(row) && !unlock.isUnlocked(req)) throw new HttpError('asset not found', 404);
    return id;
  };

  /**
   * Cache-Control for an asset's bytes. A hidden asset may only be cached until the
   * unlock that fetched it expires, so the browser cannot show it after relocking.
   */
  const cacheFor = (req: FastifyRequest, row: AssetRow, maxAge: number, immutable = false) => {
    if (!isHidden(row)) return `private, max-age=${maxAge}${immutable ? ', immutable' : ''}`;
    const left = Math.floor(((unlock.until(req) ?? 0) - Date.now()) / 1000);
    return left > 0 ? `private, max-age=${Math.min(maxAge, left)}` : 'no-store';
  };

  /** Absolute path of an asset's bytes: in its library, or in the trash. */
  const assetFile = async (row: AssetRow): Promise<string> => {
    if (row.status === 'trashed') {
      const p = path.resolve(trash.root, row.trash_path ?? '');
      if (!row.trash_path || !isInside(trash.root, p)) throw new HttpError('file not found', 404);
      return p;
    }
    return resolveInside(libState(row.library_id, null).cfg.path, row.rel_path);
  };

  // ---- Session / status ----------------------------------------------------

  // Remaining time rather than a timestamp, so the browser's clock does not matter.
  const sessionJson = (req: FastifyRequest, until = unlock.until(req)) =>
    ({
      csrf: csrfToken, hiddenEnabled: unlock.enabled, unlockMinutes: cfg.hidden.unlockMinutes,
      unlockedForMs: until ? Math.max(0, until - Date.now()) : 0,
    });

  app.get('/api/session', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return sessionJson(req);
  });

  app.post('/api/unlock', async (req, reply) => {
    const until = await unlock.unlock(req, reply, (req.body as { passphrase?: unknown } | null)?.passphrase);
    reply.header('Cache-Control', 'no-store');
    return sessionJson(req, until);
  });

  app.post('/api/lock', async (req, reply) => {
    unlock.lock(req, reply);
    reply.header('Cache-Control', 'no-store');
    return sessionJson(req, null);
  });

  app.get('/api/libraries', async (req) => {
    const counts = new Map(
      db.all<{ library_id: string; n: number; images: number; videos: number }>(
        `SELECT library_id, count(*) AS n, sum(kind = 'image') AS images, sum(kind = 'video') AS videos
         FROM assets WHERE status = 'ready' AND ${visible(req)} GROUP BY library_id`,
      ).map((r) => [r.library_id, r]),
    );
    const unlocked = unlock.isUnlocked(req);
    return {
      libraries: cfg.libraries.filter((l) => unlocked || !l.hidden).map((l) => {
        const s = indexer.libs.get(l.id)!;
        const c = counts.get(l.id);
        return {
          id: l.id, name: l.name, writable: l.writable, recursive: l.recursive, showInAll: l.showInAll, hidden: l.hidden,
          count: c?.n ?? 0, images: c?.images ?? 0, videos: c?.videos ?? 0,
          available: !!s.realRoot, error: s.error, scanning: s.scanning, lastScanMs: s.lastScanMs,
        };
      }),
    };
  });

  app.get('/api/status', async (req) => {
    const trashCount = db.get<{ n: number }>(`SELECT count(*) AS n FROM assets WHERE status = 'trashed' AND ${visible(req)}`)!.n;
    return {
      pending: indexer.pendingCount(),
      scanning: [...indexer.libs.values()].some((s) => s.scanning),
      current: indexer.current,
      trash: trashCount,
      trashRetentionDays: cfg.trash.retentionDays,
    };
  });

  // ---- Browsing --------------------------------------------------------------

  app.get('/api/folders', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const lib = libState(q.library ?? '', req).cfg;
    const parent = checkFolder(q.folder ?? '');
    const prefix = parent ? parent + '/' : '';
    // '/' sorts just before '0', so [prefix, prefix-with-'0') covers all descendants.
    const rows = parent
      ? db.all<{ folder: string; n: number; latest: number; cover: number }>(
          `SELECT folder, count(*) AS n, max(mtime_ms) AS latest, max(id) AS cover FROM assets
           WHERE status = 'ready' AND ${visible(req)} AND library_id = ? AND folder >= ? AND folder < ? GROUP BY folder`,
          lib.id, prefix, parent + '0')
      : db.all<{ folder: string; n: number; latest: number; cover: number }>(
          `SELECT folder, count(*) AS n, max(mtime_ms) AS latest, max(id) AS cover FROM assets
           WHERE status = 'ready' AND ${visible(req)} AND library_id = ? AND folder != '' GROUP BY folder`, lib.id);
    const children = new Map<string, { path: string; name: string; count: number; latestMs: number }>();
    for (const r of rows) {
      const name = r.folder.slice(prefix.length).split('/')[0];
      const p = prefix + name;
      const c = children.get(p) ?? { path: p, name, count: 0, latestMs: 0 };
      c.count += r.n;
      c.latestMs = Math.max(c.latestMs, r.latest);
      children.set(p, c);
    }
    const folders = [...children.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    // Cover image: newest asset in each folder subtree, never a hidden one (even when unlocked).
    const withCover = folders.map((f) => {
      const cover = db.get<AssetRow>(
        `SELECT * FROM assets WHERE status = 'ready' AND ${notHidden} AND library_id = ? AND (folder = ? OR (folder >= ? AND folder < ?))
         ORDER BY mtime_ms DESC, id DESC LIMIT 1`,
        lib.id, f.path, f.path + '/', f.path + '0');
      return { ...f, cover: cover ? { id: cover.id, v: cover.fingerprint.slice(0, 12) } : null };
    });
    return { folders: withCover };
  });

  app.get('/api/assets', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const where: string[] = ["status = 'ready'", visible(req)];
    const params: (string | number)[] = [];
    if (q.library) {
      where.push('library_id = ?');
      params.push(libState(q.library, req).cfg.id);
      const folder = checkFolder(q.folder ?? '');
      const recursive = q.recursive !== '0';
      if (folder && recursive) {
        where.push('(folder = ? OR (folder >= ? AND folder < ?))');
        params.push(folder, folder + '/', folder + '0');
      } else if (folder || !recursive) {
        where.push('folder = ?');
        params.push(folder);
      }
    } else if (!q.tag) {
      // Cross-library views only cover libraries that opt in (a tag view covers all of them).
      const ids = cfg.libraries.filter((l) => l.showInAll).map((l) => l.id);
      where.push(ids.length ? `library_id IN (${ids.map(() => '?').join(',')})` : '0');
      params.push(...ids);
    }
    if (q.tag) {
      // A hidden tag matches nothing while locked, like a tag that does not exist.
      const tagHidden = unlock.isUnlocked(req) ? '' : ' AND tags.hidden = 0';
      where.push(`EXISTS (SELECT 1 FROM asset_tags JOIN tags ON tags.id = asset_tags.tag_id WHERE asset_tags.asset_id = assets.id AND tags.name = ?${tagHidden})`);
      params.push(checkTagName(q.tag));
    }
    if (q.favorite === '1') where.push('favorite = 1');
    const minRating = intParam(q.minRating, 'minRating', 0, 5, 0);
    if (minRating > 0) {
      where.push('rating >= ?');
      params.push(minRating);
    }
    if (q.kind === 'image' || q.kind === 'video') {
      where.push('kind = ?');
      params.push(q.kind);
    }
    if (q.caption) {
      if (q.caption === 'any') where.push('caption_status IS NOT NULL');
      else if (q.caption === 'none') where.push('caption_status IS NULL');
      else if (q.caption === 'candidate') where.push('has_candidate = 1');
      else if ((CAPTION_STATUSES as readonly string[]).includes(q.caption)) {
        where.push('caption_status = ?');
        params.push(q.caption);
      } else throw new HttpError('invalid caption filter', 400);
    }
    const asc = q.order === 'asc';
    const limit = intParam(q.limit, 'limit', 1, PAGE_MAX, 120);
    if (q.cursor) {
      const m = /^(\d+)_(\d+)$/.exec(q.cursor);
      if (!m) throw new HttpError('invalid cursor', 400);
      where.push(asc ? '(mtime_ms > ? OR (mtime_ms = ? AND id > ?))' : '(mtime_ms < ? OR (mtime_ms = ? AND id < ?))');
      params.push(Number(m[1]), Number(m[1]), Number(m[2]));
    }
    const dir = asc ? 'ASC' : 'DESC';
    const rows = db.all<AssetRow>(
      `${CAPTION_JOIN} WHERE ${where.join(' AND ')} ORDER BY mtime_ms ${dir}, id ${dir} LIMIT ?`,
      ...params, limit + 1,
    );
    const more = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    let total: number | undefined;
    if (!q.cursor) {
      total = db.get<{ n: number }>(
        `SELECT count(*) AS n FROM assets LEFT JOIN captions ON captions.asset_id = assets.id WHERE ${where.join(' AND ')}`, ...params,
      )!.n;
    }
    return {
      items: page.map((r) => toJson(req, r)),
      next: more && last ? `${last.mtime_ms}_${last.id}` : null,
      total,
    };
  });

  app.get('/api/assets/:id', async (req) => {
    const row = getAsset(req, ['ready', 'trashed']);
    const lib = indexer.libs.get(row.library_id);
    return { ...toJson(req, row), libraryName: lib?.cfg.name ?? row.library_id, writable: !!lib?.cfg.writable };
  });

  app.get('/api/assets/:id/metadata', async (req) => {
    const row = getAsset(req, ['ready', 'trashed']);
    const m = db.metadata(row.id);
    let summary: GenerationSummary | null = null;
    let extra: Record<string, string> = {};
    try {
      summary = m?.summary_json ? JSON.parse(m.summary_json) : null;
      extra = m?.extra_json ? JSON.parse(m.extra_json) : {};
      for (const k of Object.keys(extra)) extra[k] = unquoteJsonString(extra[k]);
    } catch {
      /* corrupt row: fall through with what we have */
    }
    return {
      indexState: row.index_state,
      indexError: row.index_error,
      summary,
      extra,
      parameters: m?.parameters ?? null,
      hasPrompt: !!m?.prompt_json,
      hasWorkflow: !!m?.workflow_json,
      promptBytes: m?.prompt_json?.length ?? 0,
      workflowBytes: m?.workflow_json?.length ?? 0,
    };
  });

  // Caption sidecars are read from disk on every request: they are the source of truth.
  const captionJson = (c: Awaited<ReturnType<Captions['get']>>) => ({
    txt: c.txt,
    json: c.json,
    jsonError: c.jsonError,
    status: c.status,
    // What a later POST must send back for its conflict check.
    updated_at: typeof c.json?.updated_at === 'string' ? c.json.updated_at : null,
    txt_sha256: c.txtSha256,
    json_sha256: c.jsonSha256,
    writable: c.writable,
  });

  app.get('/api/assets/:id/caption', async (req, reply) => {
    const row = getAsset(req);
    reply.header('Cache-Control', 'no-store');
    return captionJson(await captions.get(row));
  });

  app.post('/api/assets/:id/caption', async (req) => {
    const row = getAsset(req);
    return captionJson(await captions.act(row, parseCaptionRequest(req.body)));
  });

  app.get('/api/assets/:id/raw/:which', async (req, reply) => {
    const { which } = req.params as { which: string };
    const row = getAsset(req, ['ready', 'trashed']);
    if (which !== 'prompt' && which !== 'workflow') throw new HttpError('unknown metadata kind', 404);
    const m = db.metadata(row.id);
    const text = which === 'prompt' ? m?.prompt_json : m?.workflow_json;
    if (!text) throw new HttpError('not available', 404);
    const download = (req.query as Record<string, string>).download === '1';
    reply.type('application/json; charset=utf-8');
    if (download) {
      const base = row.name.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_');
      reply.header('Content-Disposition', `attachment; filename="${base}.${which}.json"`);
    }
    return reply.send(text);
  });

  // ---- Files -----------------------------------------------------------------

  const sendCached = (req: FastifyRequest, reply: FastifyReply, row: AssetRow, file: string) => {
    reply.header('Cache-Control', cacheFor(req, row, 31536000, true));
    return reply.sendFile(path.basename(file), path.dirname(file), { cacheControl: false });
  };

  app.get('/api/assets/:id/thumb', async (req, reply) => {
    const row = getAsset(req, ['ready', 'trashed']);
    const file = await assetFile(row);
    try {
      const out = await ensureThumb(file, row.kind, row.fingerprint, indexer.thumbOptions());
      if (row.thumb_error) db.run('UPDATE assets SET thumb_error = NULL WHERE id = ?', row.id);
      return sendCached(req, reply, row, out);
    } catch (err) {
      db.run('UPDATE assets SET thumb_error = ? WHERE id = ?', (err as Error).message.slice(0, 500), row.id);
      throw new HttpError('thumbnail unavailable', 422);
    }
  });

  app.get('/api/assets/:id/preview', async (req, reply) => {
    const row = getAsset(req, ['ready', 'trashed']);
    if (row.kind !== 'image') throw new HttpError('previews are for images only', 400);
    const file = await assetFile(row);
    const out = await ensurePreview(file, row.fingerprint, indexer.thumbOptions()).catch(() => {
      throw new HttpError('preview unavailable', 422);
    });
    return sendCached(req, reply, row, out);
  });

  app.get('/api/assets/:id/file', async (req, reply) => {
    const row = getAsset(req, ['ready', 'trashed']);
    const file = await assetFile(row);
    const type = mediaType(row.name);
    reply.header('Cache-Control', cacheFor(req, row, 300));
    reply.header('Content-Security-Policy', "default-src 'none'; sandbox");
    if ((req.query as Record<string, string>).download === '1') {
      reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(row.name)}`);
    }
    if (type) reply.type(type.mime);
    // send() handles Range requests (video scrubbing), ETag and HEAD.
    return reply.sendFile(path.basename(file), path.dirname(file), { cacheControl: false, dotfiles: 'allow', contentType: false });
  });

  // ---- Mutations ----------------------------------------------------------------

  app.post('/api/assets/:id/favorite', async (req) => {
    const row = getAsset(req, ['ready']);
    const body = (req.body ?? {}) as { favorite?: unknown };
    if (typeof body.favorite !== 'boolean') throw new HttpError('favorite must be true or false', 400);
    db.setFavorite(row.id, body.favorite);
    return toJson(req, db.asset(row.id)!);
  });

  app.post('/api/assets/:id/rating', async (req) => {
    const row = getAsset(req, ['ready']);
    const body = (req.body ?? {}) as { rating?: unknown };
    const rating = intParam(body.rating, 'rating', 0, 5);
    db.setRating(row.id, rating);
    return toJson(req, db.asset(row.id)!);
  });

  app.post('/api/assets/:id/tags', async (req) => {
    const row = getAsset(req, ['ready']);
    tags.update(row.id, (req.body ?? {}) as { add?: unknown; remove?: unknown });
    return toJson(req, db.asset(row.id)!);
  });

  app.get('/api/tags', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    // Covers are never hidden items, as for folders.
    return { tags: tags.list(visible(req), notHidden, unlock.isUnlocked(req)) };
  });

  /** A tag id this request may see: hidden tags are unknown while locked. */
  const visibleTag = (req: FastifyRequest) => {
    const id = intParam((req.params as { id: string }).id, 'id', 1, Number.MAX_SAFE_INTEGER);
    if (tags.isHidden(id) && !unlock.isUnlocked(req)) throw new HttpError('tag not found', 404);
    return id;
  };

  app.post('/api/tags/:id/rename', async (req) => {
    const id = visibleTag(req);
    return tags.rename(id, ((req.body ?? {}) as { name?: unknown }).name);
  });

  app.post('/api/tags/:id/delete', async (req) => {
    tags.delete(visibleTag(req));
    return { ok: true };
  });

  // As for assets: hiding works while locked, unhiding needs an unlock.
  app.post('/api/tags/:id/hidden', async (req) => {
    const id = visibleTag(req);
    const body = (req.body ?? {}) as { hidden?: unknown };
    if (typeof body.hidden !== 'boolean') throw new HttpError('hidden must be true or false', 400);
    tags.setHidden(id, body.hidden);
    return { ok: true };
  });

  // Hiding works while locked; unhiding needs an unlock (a locked browser cannot even see the asset).
  app.post('/api/assets/:id/hidden', async (req) => {
    const row = getAsset(req, ['ready']);
    const body = (req.body ?? {}) as { hidden?: unknown };
    if (typeof body.hidden !== 'boolean') throw new HttpError('hidden must be true or false', 400);
    db.setHidden(row.id, body.hidden);
    return toJson(req, db.asset(row.id)!);
  });

  app.post('/api/assets/:id/trash', async (req) => {
    const id = visibleId(req);
    const body = (req.body ?? {}) as { size?: unknown; mtimeMs?: unknown };
    const expected = {
      size: typeof body.size === 'number' ? body.size : undefined,
      mtimeMs: typeof body.mtimeMs === 'number' ? body.mtimeMs : undefined,
    };
    return toJson(req, await trash.trash(id, expected));
  });

  app.get('/api/trash', async (req) => {
    const rows = db.all<AssetRow>(`SELECT * FROM assets WHERE status = 'trashed' AND ${visible(req)} ORDER BY trashed_at_ms DESC LIMIT 2000`);
    return {
      retentionDays: cfg.trash.retentionDays,
      items: rows.map((r) => ({
        ...toJson(req, r),
        libraryName: indexer.libs.get(r.library_id)?.cfg.name ?? r.library_id,
        expiresAtMs: (r.trashed_at_ms ?? 0) + cfg.trash.retentionDays * 86_400_000,
      })),
    };
  });

  app.post('/api/trash/:id/restore', async (req) => {
    const id = visibleId(req);
    return toJson(req, await trash.restore(id));
  });

  app.post('/api/trash/:id/purge', async (req) => {
    const id = visibleId(req);
    await trash.purge(id);
    return { ok: true };
  });

  /** Permanently deletes everything in the trash this request can see (hidden items stay while locked). */
  app.post('/api/trash/purge-all', async (req) => {
    const rows = db.all<{ id: number }>(`SELECT id FROM assets WHERE status = 'trashed' AND ${visible(req)}`);
    let deleted = 0;
    let lastError: string | null = null;
    for (const { id } of rows) {
      try {
        await trash.purge(id);
        deleted++;
      } catch (err) {
        lastError = (err as Error).message;
      }
    }
    return { deleted, failed: rows.length - deleted, error: lastError };
  });

  app.post('/api/rescan', async (req) => {
    const body = (req.body ?? {}) as { library?: unknown };
    if (body.library !== undefined) {
      if (typeof body.library !== 'string') throw new HttpError('library must be a string', 400);
      void indexer.scanLibrary(libState(body.library, req).cfg.id);
    } else {
      void indexer.scanAll();
    }
    return { ok: true };
  });

  /**
   * A gallery image by its absolute path (as copied in the viewer), for the video flow's
   * input. Only paths inside a library, of an indexed image this request may see.
   */
  const imageAt = async (req: FastifyRequest, file: string) => {
    if (!path.isAbsolute(file)) throw new HttpError('paste an absolute path, as copied in the viewer', 400);
    const p = path.resolve(file);
    const lib = cfg.libraries.filter((l) => isInside(l.path, p)).sort((a, b) => b.path.length - a.path.length)[0];
    const rel = lib && path.relative(lib.path, p).split(path.sep).join('/');
    const row = lib && rel ? db.liveAt(lib.id, rel) : undefined;
    if (!row || (isHidden(row) && !unlock.isUnlocked(req))) throw new HttpError('not an image in the gallery', 404);
    if (row.kind !== 'image') throw new HttpError('pick an image, not a video', 400);
    return { row, asset: toJson(req, row), file: await assetFile(row) };
  };

  registerGenerate(app, cfg, db, imageAt, deps.generate);

  // ---- Live updates (Server-Sent Events) ------------------------------------------

  // Each stream keeps its request, so hidden library ids only go to unlocked browsers.
  const clients = new Map<FastifyReply, FastifyRequest>();
  const onChange = (ev: ChangeEvent) => {
    const data = `event: change\ndata: ${JSON.stringify(ev)}\n\n`;
    const shown = { ...ev, libraries: ev.libraries.filter((id) => !hiddenLibs.has(id)) };
    const locked = `event: change\ndata: ${JSON.stringify(shown)}\n\n`;
    for (const [c, req] of clients) c.raw.write(hiddenLibs.size && !unlock.isUnlocked(req) ? locked : data);
  };
  indexer.on('change', onChange);
  const ping = setInterval(() => {
    for (const c of clients.keys()) c.raw.write(': ping\n\n');
  }, 25_000);
  ping.unref();
  // preClose: end live streams before the server waits for open connections to drain.
  app.addHook('preClose', async () => {
    clearInterval(ping);
    indexer.off('change', onChange);
    for (const c of clients.keys()) c.raw.end();
    clients.clear();
  });

  app.get('/api/events', (req: FastifyRequest, reply: FastifyReply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write('retry: 5000\n\n');
    clients.set(reply, req);
    req.raw.on('close', () => clients.delete(reply));
  });

  // ---- Frontend -----------------------------------------------------------------------

  // Registered even without a web root so reply.sendFile is available for media.
  const webRoot = deps.webRoot && fs.existsSync(deps.webRoot) ? deps.webRoot : null;
  await app.register(fastifyStatic, {
    root: webRoot ?? process.cwd(),
    serve: !!webRoot,
    // Look files up per request (not just those present at startup), so a rebuild
    // with new hashed asset names never needs a restart to be served.
    wildcard: true,
    setHeaders: (res, p) => {
      if (p.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      else res.setHeader('Cache-Control', 'no-cache');
    },
  });
  app.setNotFoundHandler((req, reply) => {
    // Missing files under /assets/ must 404, not fall back to index.html (which a browser
    // would try to run as JavaScript and render a blank page).
    if (req.url.startsWith('/api/') || req.url.startsWith('/assets/') || !webRoot || req.method !== 'GET') {
      return reply.code(404).send({ error: 'not found' });
    }
    reply.header('Cache-Control', 'no-cache');
    return reply.sendFile('index.html', webRoot);
  });

  return app;
}
