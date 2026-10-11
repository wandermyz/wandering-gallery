import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { AppConfig } from './config.js';
import { Captions, CAPTION_STATUSES, parseCaptionRequest } from './captions.js';
import { CAPTION_JOIN, TAG_SEP, type AssetRow, type Db } from './db.js';
import { registerGenerate } from './generate/routes.js';
import type { ComfyClient } from './generate/comfy.js';
import type { ChangeEvent, Indexer } from './indexer.js';
import { videoPlayability, mediaType } from './media.js';
import type { GenerationSummary } from './metadata/comfyui.js';
import { checkFolder, HttpError, isInside, resolveInside } from './paths.js';
import { checkTagName, Tags } from './tags.js';
import { ensurePreview, ensureThumb } from './thumbs.js';
import { Trash } from './trash.js';

export interface AppDeps {
  cfg: AppConfig;
  db: Db;
  indexer: Indexer;
  trash: Trash;
  webRoot?: string | null;
  /** A pino logger instance, or false to disable request logging. */
  logger?: FastifyBaseLogger | false;
  /** ComfyUI access for the generate flows (tests pass a fake). */
  comfy?: ComfyClient;
}

const PAGE_MAX = 500;
/** Images above this many pixels (or bytes) get a resized preview in the viewer. */
const PREVIEW_PIXELS = 3000 * 3000;
const PREVIEW_BYTES = 15 * 1024 * 1024;

/** Public shape of an asset sent to the browser. */
function assetJson(r: AssetRow) {
  return {
    id: r.id,
    library: r.library_id,
    path: r.rel_path,
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
    status: r.status,
    trashedAtMs: r.trashed_at_ms,
    caption: (r.caption_status ?? null) as string | null,
    captionCandidate: !!r.has_candidate,
    captionRev: r.caption_rev ?? 0,
    tags: r.tag_names ? r.tag_names.split(TAG_SEP) : [],
    // Thumbnail URLs embed the fingerprint so browsers can cache them forever.
    v: r.fingerprint.slice(0, 12),
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
    if (err instanceof HttpError) return reply.code(err.status).send({ ...err.data, error: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    req.log.error(err);
    return reply.code(500).send({ error: 'internal error' });
  });

  const libState = (id: string) => {
    const s = indexer.libs.get(id);
    if (!s) throw new HttpError('unknown library', 404);
    return s;
  };

  const getAsset = (idParam: unknown, statuses: string[] = ['ready']) => {
    const id = intParam(idParam, 'id', 1, Number.MAX_SAFE_INTEGER);
    const row = db.asset(id);
    if (!row || !statuses.includes(row.status)) throw new HttpError('asset not found', 404);
    return row;
  };

  /** Absolute path of an asset's bytes: in its library, or in the trash. */
  const assetFile = async (row: AssetRow): Promise<string> => {
    if (row.status === 'trashed') {
      const p = path.resolve(trash.root, row.trash_path ?? '');
      if (!row.trash_path || !isInside(trash.root, p)) throw new HttpError('file not found', 404);
      return p;
    }
    return resolveInside(libState(row.library_id).cfg.path, row.rel_path);
  };

  // ---- Session / status ----------------------------------------------------

  app.get('/api/session', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { csrf: csrfToken };
  });

  app.get('/api/libraries', async () => {
    const counts = new Map(
      db.all<{ library_id: string; n: number; images: number; videos: number }>(
        `SELECT library_id, count(*) AS n, sum(kind = 'image') AS images, sum(kind = 'video') AS videos
         FROM assets WHERE status = 'ready' GROUP BY library_id`,
      ).map((r) => [r.library_id, r]),
    );
    return {
      libraries: cfg.libraries.map((l) => {
        const s = indexer.libs.get(l.id)!;
        const c = counts.get(l.id);
        return {
          id: l.id, name: l.name, writable: l.writable, recursive: l.recursive, showInAll: l.showInAll,
          count: c?.n ?? 0, images: c?.images ?? 0, videos: c?.videos ?? 0,
          available: !!s.realRoot, error: s.error, scanning: s.scanning, lastScanMs: s.lastScanMs,
        };
      }),
    };
  });

  app.get('/api/status', async () => {
    const trashCount = db.get<{ n: number }>("SELECT count(*) AS n FROM assets WHERE status = 'trashed'")!.n;
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
    const lib = libState(q.library ?? '').cfg;
    const parent = checkFolder(q.folder ?? '');
    const prefix = parent ? parent + '/' : '';
    // '/' sorts just before '0', so [prefix, prefix-with-'0') covers all descendants.
    const rows = parent
      ? db.all<{ folder: string; n: number; latest: number; cover: number }>(
          `SELECT folder, count(*) AS n, max(mtime_ms) AS latest, max(id) AS cover FROM assets
           WHERE status = 'ready' AND library_id = ? AND folder >= ? AND folder < ? GROUP BY folder`,
          lib.id, prefix, parent + '0')
      : db.all<{ folder: string; n: number; latest: number; cover: number }>(
          `SELECT folder, count(*) AS n, max(mtime_ms) AS latest, max(id) AS cover FROM assets
           WHERE status = 'ready' AND library_id = ? AND folder != '' GROUP BY folder`, lib.id);
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
    // Cover image: newest asset in each folder subtree.
    const withCover = folders.map((f) => {
      const cover = db.get<AssetRow>(
        `SELECT * FROM assets WHERE status = 'ready' AND library_id = ? AND (folder = ? OR (folder >= ? AND folder < ?))
         ORDER BY mtime_ms DESC, id DESC LIMIT 1`,
        lib.id, f.path, f.path + '/', f.path + '0');
      return { ...f, cover: cover ? { id: cover.id, v: cover.fingerprint.slice(0, 12) } : null };
    });
    return { folders: withCover };
  });

  app.get('/api/assets', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const where: string[] = ["status = 'ready'"];
    const params: (string | number)[] = [];
    if (q.library) {
      where.push('library_id = ?');
      params.push(libState(q.library).cfg.id);
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
      where.push('EXISTS (SELECT 1 FROM asset_tags JOIN tags ON tags.id = asset_tags.tag_id WHERE asset_tags.asset_id = assets.id AND tags.name = ?)');
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
      items: page.map(assetJson),
      next: more && last ? `${last.mtime_ms}_${last.id}` : null,
      total,
    };
  });

  app.get('/api/assets/:id', async (req) => {
    const row = getAsset((req.params as { id: string }).id, ['ready', 'trashed']);
    const lib = indexer.libs.get(row.library_id);
    return { ...assetJson(row), libraryName: lib?.cfg.name ?? row.library_id, writable: !!lib?.cfg.writable };
  });

  app.get('/api/assets/:id/metadata', async (req) => {
    const row = getAsset((req.params as { id: string }).id, ['ready', 'trashed']);
    const m = db.metadata(row.id);
    let summary: GenerationSummary | null = null;
    let extra: Record<string, string> = {};
    try {
      summary = m?.summary_json ? JSON.parse(m.summary_json) : null;
      extra = m?.extra_json ? JSON.parse(m.extra_json) : {};
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
    const row = getAsset((req.params as { id: string }).id);
    reply.header('Cache-Control', 'no-store');
    return captionJson(await captions.get(row));
  });

  app.post('/api/assets/:id/caption', async (req) => {
    const row = getAsset((req.params as { id: string }).id);
    return captionJson(await captions.act(row, parseCaptionRequest(req.body)));
  });

  app.get('/api/assets/:id/raw/:which', async (req, reply) => {
    const { id, which } = req.params as { id: string; which: string };
    const row = getAsset(id, ['ready', 'trashed']);
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

  const sendCached = (reply: FastifyReply, file: string, immutable: boolean) => {
    reply.header('Cache-Control', immutable ? 'private, max-age=31536000, immutable' : 'private, max-age=60');
    return reply.sendFile(path.basename(file), path.dirname(file), { cacheControl: false });
  };

  app.get('/api/assets/:id/thumb', async (req, reply) => {
    const row = getAsset((req.params as { id: string }).id, ['ready', 'trashed']);
    const file = await assetFile(row);
    try {
      const out = await ensureThumb(file, row.kind, row.fingerprint, indexer.thumbOptions());
      if (row.thumb_error) db.run('UPDATE assets SET thumb_error = NULL WHERE id = ?', row.id);
      return sendCached(reply, out, true);
    } catch (err) {
      db.run('UPDATE assets SET thumb_error = ? WHERE id = ?', (err as Error).message.slice(0, 500), row.id);
      throw new HttpError('thumbnail unavailable', 422);
    }
  });

  app.get('/api/assets/:id/preview', async (req, reply) => {
    const row = getAsset((req.params as { id: string }).id, ['ready', 'trashed']);
    if (row.kind !== 'image') throw new HttpError('previews are for images only', 400);
    const file = await assetFile(row);
    const out = await ensurePreview(file, row.fingerprint, indexer.thumbOptions()).catch(() => {
      throw new HttpError('preview unavailable', 422);
    });
    return sendCached(reply, out, true);
  });

  app.get('/api/assets/:id/file', async (req, reply) => {
    const row = getAsset((req.params as { id: string }).id, ['ready', 'trashed']);
    const file = await assetFile(row);
    const type = mediaType(row.name);
    reply.header('Cache-Control', 'private, max-age=300');
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
    const row = getAsset((req.params as { id: string }).id, ['ready']);
    const body = (req.body ?? {}) as { favorite?: unknown };
    if (typeof body.favorite !== 'boolean') throw new HttpError('favorite must be true or false', 400);
    db.setFavorite(row.id, body.favorite);
    return assetJson(db.asset(row.id)!);
  });

  app.post('/api/assets/:id/rating', async (req) => {
    const row = getAsset((req.params as { id: string }).id, ['ready']);
    const body = (req.body ?? {}) as { rating?: unknown };
    const rating = intParam(body.rating, 'rating', 0, 5);
    db.setRating(row.id, rating);
    return assetJson(db.asset(row.id)!);
  });

  app.post('/api/assets/:id/tags', async (req) => {
    const row = getAsset((req.params as { id: string }).id, ['ready']);
    tags.update(row.id, (req.body ?? {}) as { add?: unknown; remove?: unknown });
    return assetJson(db.asset(row.id)!);
  });

  app.get('/api/tags', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { tags: tags.list() };
  });

  app.post('/api/tags/:id/rename', async (req) => {
    const id = intParam((req.params as { id: string }).id, 'id', 1, Number.MAX_SAFE_INTEGER);
    return tags.rename(id, ((req.body ?? {}) as { name?: unknown }).name);
  });

  app.post('/api/tags/:id/delete', async (req) => {
    const id = intParam((req.params as { id: string }).id, 'id', 1, Number.MAX_SAFE_INTEGER);
    tags.delete(id);
    return { ok: true };
  });

  app.post('/api/assets/:id/trash', async (req) => {
    const id = intParam((req.params as { id: string }).id, 'id', 1, Number.MAX_SAFE_INTEGER);
    const body = (req.body ?? {}) as { size?: unknown; mtimeMs?: unknown };
    const expected = {
      size: typeof body.size === 'number' ? body.size : undefined,
      mtimeMs: typeof body.mtimeMs === 'number' ? body.mtimeMs : undefined,
    };
    return assetJson(await trash.trash(id, expected));
  });

  app.get('/api/trash', async () => {
    const rows = db.all<AssetRow>("SELECT * FROM assets WHERE status = 'trashed' ORDER BY trashed_at_ms DESC LIMIT 2000");
    return {
      retentionDays: cfg.trash.retentionDays,
      items: rows.map((r) => ({
        ...assetJson(r),
        libraryName: indexer.libs.get(r.library_id)?.cfg.name ?? r.library_id,
        expiresAtMs: (r.trashed_at_ms ?? 0) + cfg.trash.retentionDays * 86_400_000,
      })),
    };
  });

  app.post('/api/trash/:id/restore', async (req) => {
    const id = intParam((req.params as { id: string }).id, 'id', 1, Number.MAX_SAFE_INTEGER);
    return assetJson(await trash.restore(id));
  });

  app.post('/api/trash/:id/purge', async (req) => {
    const id = intParam((req.params as { id: string }).id, 'id', 1, Number.MAX_SAFE_INTEGER);
    await trash.purge(id);
    return { ok: true };
  });

  app.post('/api/rescan', async (req) => {
    const body = (req.body ?? {}) as { library?: unknown };
    if (body.library !== undefined) {
      if (typeof body.library !== 'string') throw new HttpError('library must be a string', 400);
      void indexer.scanLibrary(libState(body.library).cfg.id);
    } else {
      void indexer.scanAll();
    }
    return { ok: true };
  });

  registerGenerate(app, cfg, db, deps.comfy);

  // ---- Live updates (Server-Sent Events) ------------------------------------------

  const clients = new Set<FastifyReply>();
  const onChange = (ev: ChangeEvent) => {
    const data = `event: change\ndata: ${JSON.stringify(ev)}\n\n`;
    for (const c of clients) c.raw.write(data);
  };
  indexer.on('change', onChange);
  const ping = setInterval(() => {
    for (const c of clients) c.raw.write(': ping\n\n');
  }, 25_000);
  ping.unref();
  // preClose: end live streams before the server waits for open connections to drain.
  app.addHook('preClose', async () => {
    clearInterval(ping);
    indexer.off('change', onChange);
    for (const c of clients) c.raw.end();
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
    clients.add(reply);
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
