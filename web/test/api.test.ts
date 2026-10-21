import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app.js';
import { Indexer } from '../src/server/indexer.js';
import { ageAll, fixture, hasFfmpeg, makeEnv, makePng, makeVideo, sha, type Env } from './helpers.js';

let env: Env;
let app: FastifyInstance;
afterEach(async () => {
  await app?.close();
  await env?.close();
  env = undefined!;
  app = undefined!;
});

async function setup(libs?: Parameters<typeof makeEnv>[0]) {
  env = await makeEnv(libs);
  app = await buildApp({ cfg: env.cfg, db: env.db, indexer: env.indexer, trash: env.trash, webRoot: null });
  return { env, app };
}

async function csrf(): Promise<string> {
  return (await app.inject({ url: '/api/session' })).json().csrf;
}

async function post(url: string, body: unknown = {}, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST', url, payload: body as object,
    headers: { 'x-csrf-token': await csrf(), 'content-type': 'application/json', ...headers },
  });
}

describe('HTTP API', () => {
  it('lists libraries, folders and paginated assets newest first', async () => {
    await setup([{ id: 'a' }, { id: 'b', writable: false }]);
    for (let i = 0; i < 5; i++) await makePng(path.join(env.lib('a'), 'f', `${i}.png`), { color: `#00${i}${i}00` });
    await makePng(path.join(env.lib('b'), 'x.png'));
    ageAll(env.root);
    // Give each file a distinct mtime.
    for (let i = 0; i < 5; i++) {
      const t = new Date(Date.now() - (100 - i) * 1000);
      fs.utimesSync(path.join(env.lib('a'), 'f', `${i}.png`), t, t);
    }
    await env.sync();

    const libs = (await app.inject({ url: '/api/libraries' })).json().libraries;
    expect(libs.map((l: { id: string; count: number; writable: boolean }) => [l.id, l.count, l.writable])).toEqual([['a', 5, true], ['b', 1, false]]);

    const folders = (await app.inject({ url: '/api/folders?library=a' })).json().folders;
    expect(folders).toMatchObject([{ path: 'f', name: 'f', count: 5 }]);

    const p1 = (await app.inject({ url: '/api/assets?library=a&limit=2' })).json();
    expect(p1.total).toBe(5);
    expect(p1.items.map((x: { name: string }) => x.name)).toEqual(['4.png', '3.png']);
    const p2 = (await app.inject({ url: `/api/assets?library=a&limit=2&cursor=${p1.next}` })).json();
    expect(p2.items.map((x: { name: string }) => x.name)).toEqual(['2.png', '1.png']);
    const p3 = (await app.inject({ url: `/api/assets?library=a&limit=2&cursor=${p2.next}` })).json();
    expect(p3.items.map((x: { name: string }) => x.name)).toEqual(['0.png']);
    expect(p3.next).toBeNull();

    const asc = (await app.inject({ url: '/api/assets?library=a&order=asc&limit=1' })).json();
    expect(asc.items[0].name).toBe('0.png');
    const all = (await app.inject({ url: '/api/assets' })).json();
    expect(all.total).toBe(6);
    const flat = (await app.inject({ url: '/api/assets?library=a&recursive=0' })).json();
    expect(flat.total).toBe(0);
  });

  it('leaves libraries with showInAll: false out of All media and Favorites', async () => {
    await setup([{ id: 'a' }, { id: 'hidden', showInAll: false }]);
    await makePng(path.join(env.lib('a'), 'x.png'));
    await makePng(path.join(env.lib('hidden'), 'y.png'), { color: '#123456' });
    ageAll(env.root);
    await env.sync();
    for (const row of env.db.all<{ id: number }>("SELECT id FROM assets WHERE status = 'ready'")) {
      expect((await post(`/api/assets/${row.id}/favorite`, { favorite: true })).statusCode).toBe(200);
    }
    const libs = (await app.inject({ url: '/api/libraries' })).json().libraries;
    expect(libs.map((l: { id: string; showInAll: boolean }) => [l.id, l.showInAll])).toEqual([['a', true], ['hidden', false]]);
    const names = async (qs: string) => (await app.inject({ url: `/api/assets${qs}` })).json().items.map((x: { name: string }) => x.name);
    expect(await names('')).toEqual(['x.png']);
    expect(await names('?favorite=1')).toEqual(['x.png']);
    expect(await names('?library=hidden')).toEqual(['y.png']);
  });

  it('updates favorites and ratings, and filters by them', async () => {
    await setup();
    await makePng(path.join(env.lib('main'), 'a.png'), { color: '#111111' });
    await makePng(path.join(env.lib('main'), 'b.png'), { color: '#222222' });
    ageAll(env.root);
    await env.sync();
    const items = (await app.inject({ url: '/api/assets' })).json().items;
    const [x, y] = items;

    expect((await post(`/api/assets/${x.id}/favorite`, { favorite: true })).json()).toMatchObject({ favorite: true });
    expect((await post(`/api/assets/${y.id}/rating`, { rating: 3 })).json()).toMatchObject({ rating: 3 });
    expect((await post(`/api/assets/${y.id}/rating`, { rating: 6 })).statusCode).toBe(400);
    expect((await post(`/api/assets/${y.id}/favorite`, { favorite: 'yes' })).statusCode).toBe(400);

    const favs = (await app.inject({ url: '/api/assets?favorite=1' })).json();
    expect(favs.items.map((i: { id: number }) => i.id)).toEqual([x.id]);
    const rated = (await app.inject({ url: '/api/assets?minRating=3' })).json();
    expect(rated.items.map((i: { id: number }) => i.id)).toEqual([y.id]);
    expect((await app.inject({ url: '/api/assets?minRating=4' })).json().total).toBe(0);

    // Clear rating.
    await post(`/api/assets/${y.id}/rating`, { rating: 0 });
    expect((await app.inject({ url: '/api/assets?minRating=1' })).json().total).toBe(0);
  });

  it('tags assets, lists tags and filters by tag', async () => {
    await setup();
    await makePng(path.join(env.lib('main'), 'a.png'), { color: '#111111' });
    await makePng(path.join(env.lib('main'), 'b.png'), { color: '#222222' });
    ageAll(env.root);
    await env.sync();
    const [x, y] = (await app.inject({ url: '/api/assets' })).json().items;
    expect(x.tags).toEqual([]);

    // New tags are created; whitespace is normalized; an existing tag matches case-insensitively.
    expect((await post(`/api/assets/${x.id}/tags`, { add: ['  Red   hair ', 'cat'] })).json().tags).toEqual(['cat', 'Red hair']);
    expect((await post(`/api/assets/${y.id}/tags`, { add: ['red hair'] })).json().tags).toEqual(['Red hair']);
    expect((await post(`/api/assets/${y.id}/tags`, { add: [''] })).statusCode).toBe(400);
    expect((await post(`/api/assets/${y.id}/tags`, { add: ['a\u0007b'] })).statusCode).toBe(400);
    expect((await post(`/api/assets/${y.id}/tags`, {})).statusCode).toBe(400);

    const list = (await app.inject({ url: '/api/tags' })).json().tags;
    expect(list.map((t: { name: string; count: number }) => [t.name, t.count])).toEqual([['cat', 1], ['Red hair', 2]]);

    const byTag = (await app.inject({ url: '/api/assets?tag=RED%20HAIR' })).json();
    expect(byTag.total).toBe(2);
    expect((await app.inject({ url: '/api/assets?tag=cat' })).json().items.map((i: { id: number }) => i.id)).toEqual([x.id]);

    // Removing; the tag stays (with no assets) until it is deleted.
    expect((await post(`/api/assets/${x.id}/tags`, { remove: ['cat'] })).json().tags).toEqual(['Red hair']);
    const cat = (await app.inject({ url: '/api/tags' })).json().tags.find((t: { name: string }) => t.name === 'cat');
    expect(cat.count).toBe(0);

    // Renaming onto an existing tag merges them.
    await post(`/api/assets/${x.id}/tags`, { add: ['cat'] });
    const red = (await app.inject({ url: '/api/tags' })).json().tags.find((t: { name: string }) => t.name === 'Red hair');
    expect((await post(`/api/tags/${cat.id}/rename`, { name: 'red hair' })).json()).toMatchObject({ merged: true });
    expect((await app.inject({ url: '/api/tags' })).json().tags.map((t: { name: string; count: number }) => [t.name, t.count])).toEqual([['red hair', 2]]);
    expect((await post(`/api/tags/${red.id}/rename`, { name: 'redhead' })).json()).toMatchObject({ merged: false, name: 'redhead' });

    expect((await post(`/api/tags/${red.id}/delete`)).json()).toEqual({ ok: true });
    expect((await app.inject({ url: `/api/assets/${x.id}` })).json().tags).toEqual([]);
    expect((await post(`/api/tags/${red.id}/delete`)).statusCode).toBe(404);
  });

  it('keeps tags through trash and restore', async () => {
    await setup();
    await makePng(path.join(env.lib('main'), 'a.png'), { color: '#111111' });
    ageAll(env.root);
    await env.sync();
    const [x] = (await app.inject({ url: '/api/assets' })).json().items;
    await post(`/api/assets/${x.id}/tags`, { add: ['keep'] });
    await post(`/api/assets/${x.id}/trash`);
    expect((await app.inject({ url: '/api/tags' })).json().tags[0].count).toBe(0);
    expect((await app.inject({ url: '/api/assets?tag=keep' })).json().total).toBe(0);
    expect((await post(`/api/trash/${x.id}/restore`)).json().tags).toEqual(['keep']);
    expect((await app.inject({ url: '/api/assets?tag=keep' })).json().total).toBe(1);
  });

  it('serves metadata summaries and raw JSON', async () => {
    await setup();
    await makePng(path.join(env.lib('main'), 'gen.png'), {
      text: { prompt: fixture('controlnet-lora.prompt.json'), workflow: fixture('sdxl-basic.workflow.json') },
    });
    await makePng(path.join(env.lib('main'), 'plain.png'));
    ageAll(env.root);
    await env.sync();
    const items = (await app.inject({ url: '/api/assets' })).json().items as { id: number; name: string; hasMeta: boolean }[];
    const gen = items.find((i) => i.name === 'gen.png')!;
    const plain = items.find((i) => i.name === 'plain.png')!;
    expect(gen.hasMeta).toBe(true);

    const m = (await app.inject({ url: `/api/assets/${gen.id}/metadata` })).json();
    expect(m.summary.positive).toEqual(['1girl, sitting on a beach, sunset']);
    expect(m.summary.loras).toHaveLength(2);
    expect(m.hasPrompt && m.hasWorkflow).toBe(true);
    const raw = await app.inject({ url: `/api/assets/${gen.id}/raw/prompt` });
    expect(raw.headers['content-type']).toMatch(/application\/json/);
    expect(JSON.parse(raw.body)).toEqual(JSON.parse(fixture('controlnet-lora.prompt.json')));
    expect((await app.inject({ url: `/api/assets/${gen.id}/raw/other` })).statusCode).toBe(404);

    const none = (await app.inject({ url: `/api/assets/${plain.id}/metadata` })).json();
    expect(none).toMatchObject({ summary: null, hasPrompt: false, hasWorkflow: false });
  });

  it('serves originals with range support, thumbnails with long caching', async () => {
    await setup();
    const file = path.join(env.lib('main'), 'a.png');
    await makePng(file, { w: 900, h: 600 });
    ageAll(env.root);
    await env.sync();
    const [a] = (await app.inject({ url: '/api/assets' })).json().items;

    const full = await app.inject({ url: `/api/assets/${a.id}/file` });
    expect(full.statusCode).toBe(200);
    expect(full.headers['content-type']).toBe('image/png');
    expect(full.rawPayload.equals(fs.readFileSync(file))).toBe(true);

    const part = await app.inject({ url: `/api/assets/${a.id}/file`, headers: { range: 'bytes=0-15' } });
    expect(part.statusCode).toBe(206);
    expect(part.rawPayload.length).toBe(16);

    const thumb = await app.inject({ url: `/api/assets/${a.id}/thumb` });
    expect(thumb.statusCode).toBe(200);
    expect(thumb.headers['content-type']).toBe('image/webp');
    expect(thumb.headers['cache-control']).toMatch(/immutable/);
  });

  it.skipIf(!hasFfmpeg)('streams video with byte ranges for scrubbing', async () => {
    await setup();
    const file = path.join(env.lib('main'), 'v.mp4');
    makeVideo(file, { seconds: 2 });
    ageAll(env.root);
    await env.sync();
    const [v] = (await app.inject({ url: '/api/assets' })).json().items;
    expect(v).toMatchObject({ kind: 'video', mime: 'video/mp4', playable: 'yes' });
    const size = fs.statSync(file).size;
    const r = await app.inject({ url: `/api/assets/${v.id}/file`, headers: { range: `bytes=${size - 100}-` } });
    expect(r.statusCode).toBe(206);
    expect(r.headers['content-range']).toBe(`bytes ${size - 100}-${size - 1}/${size}`);
  });

  it('trashes and restores via the API, and lists the trash', async () => {
    await setup();
    const file = path.join(env.lib('main'), 'a.png');
    await makePng(file);
    ageAll(env.root);
    await env.sync();
    const hash = sha(file);
    const [a] = (await app.inject({ url: '/api/assets' })).json().items;
    await post(`/api/assets/${a.id}/rating`, { rating: 5 });

    const del = await post(`/api/assets/${a.id}/trash`, { size: a.size, mtimeMs: a.mtimeMs });
    expect(del.statusCode).toBe(200);
    expect(fs.existsSync(file)).toBe(false);
    expect((await app.inject({ url: '/api/assets' })).json().total).toBe(0);
    const trash = (await app.inject({ url: '/api/trash' })).json();
    expect(trash.retentionDays).toBe(7);
    expect(trash.items).toHaveLength(1);
    // Thumbnails of trashed items still work (for the trash view).
    expect((await app.inject({ url: `/api/assets/${a.id}/thumb` })).statusCode).toBe(200);

    expect((await post(`/api/trash/${a.id}/restore`)).json()).toMatchObject({ rating: 5, status: 'ready' });
    expect(sha(file)).toBe(hash);
    expect((await app.inject({ url: '/api/trash' })).json().items).toHaveLength(0);
  });

  it('trashes and restores a batch, reporting the items that fail', async () => {
    await setup([{ id: 'main', writable: true }, { id: 'ro', writable: false }]);
    for (const n of ['a', 'b', 'c']) await makePng(path.join(env.lib('main'), `${n}.png`), { color: '#102030' });
    await makePng(path.join(env.lib('ro'), 'r.png'));
    ageAll(env.root);
    await env.sync();
    const items = (await app.inject({ url: '/api/assets' })).json().items as { id: number; name: string; size: number; mtimeMs: number }[];
    const byName = (n: string) => items.find((x) => x.name === n)!;
    const [a, b, c, r] = ['a.png', 'b.png', 'c.png', 'r.png'].map(byName);

    const del = (await post('/api/batch/trash', {
      items: [a, b, r, { id: c.id, size: c.size + 1, mtimeMs: c.mtimeMs }, { id: 999999 }].map((x) => ({ id: x.id, size: x.size, mtimeMs: x.mtimeMs })),
    })).json();
    expect(del.trashed.sort()).toEqual([a.id, b.id].sort());
    expect(del.failed).toEqual([
      { id: r.id, error: expect.stringMatching(/read-only/) },
      { id: c.id, error: expect.stringMatching(/changed on disk/) },
      { id: 999999, error: 'asset not found' },
    ]);
    expect(fs.readdirSync(env.lib('main'))).toEqual(['c.png']);

    const back = (await post('/api/batch/restore', { ids: [a.id, b.id, c.id] })).json();
    expect(back).toEqual({ restored: [a.id, b.id], failed: [{ id: c.id, error: 'asset is not in the trash' }] });
    expect(fs.readdirSync(env.lib('main')).sort()).toEqual(['a.png', 'b.png', 'c.png']);

    for (const body of [{}, { items: [] }, { items: [{ id: 'x' }] }]) {
      expect((await post('/api/batch/trash', body)).statusCode).toBe(400);
    }
  });

  it('rejects deletes on read-only libraries', async () => {
    await setup([{ id: 'ro', writable: false }]);
    const file = path.join(env.lib('ro'), 'a.png');
    await makePng(file);
    ageAll(env.root);
    await env.sync();
    const [a] = (await app.inject({ url: '/api/assets' })).json().items;
    const r = await post(`/api/assets/${a.id}/trash`);
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toMatch(/read-only/);
    expect(fs.existsSync(file)).toBe(true);
  });
});

describe('frontend serving', () => {
  it('serves assets added after startup and 404s unknown assets instead of returning HTML', async () => {
    env = await makeEnv();
    const web = path.join(env.root, 'web');
    fs.mkdirSync(path.join(web, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(web, 'index.html'), '<!doctype html><script src="/assets/app-1.js"></script>');
    app = await buildApp({ cfg: env.cfg, db: env.db, indexer: env.indexer, trash: env.trash, webRoot: web });
    // A rebuild writes new hashed files while the server keeps running.
    fs.writeFileSync(path.join(web, 'assets', 'app-2.js'), 'console.log(2)');
    const js = await app.inject({ url: '/assets/app-2.js' });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-type']).toMatch(/javascript/);
    expect((await app.inject({ url: '/assets/gone.js' })).statusCode).toBe(404);
    const spa = await app.inject({ url: '/trash?x=1' });
    expect(spa.statusCode).toBe(200);
    expect(spa.body).toContain('<!doctype html>');
  });
});

describe('request protection', () => {
  it('requires a CSRF token for state-changing requests', async () => {
    await setup();
    await makePng(path.join(env.lib('main'), 'a.png'));
    ageAll(env.root);
    await env.sync();
    const [a] = (await app.inject({ url: '/api/assets' })).json().items;
    const noToken = await app.inject({ method: 'POST', url: `/api/assets/${a.id}/trash`, payload: {} });
    expect(noToken.statusCode).toBe(403);
    const wrong = await app.inject({ method: 'POST', url: `/api/assets/${a.id}/trash`, payload: {}, headers: { 'x-csrf-token': 'x'.repeat(32) } });
    expect(wrong.statusCode).toBe(403);
    expect(fs.existsSync(path.join(env.lib('main'), 'a.png'))).toBe(true);
  });

  it('rejects cross-origin requests and unknown Host headers', async () => {
    await setup();
    const token = await csrf();
    const cross = await app.inject({
      method: 'POST', url: '/api/rescan', payload: {},
      headers: { 'x-csrf-token': token, origin: 'https://evil.example', 'content-type': 'application/json' },
    });
    expect(cross.statusCode).toBe(403);
    const same = await app.inject({
      method: 'POST', url: '/api/rescan', payload: {},
      headers: { 'x-csrf-token': token, origin: 'http://localhost:80', host: 'localhost:80', 'content-type': 'application/json' },
    });
    expect(same.statusCode).toBe(200);
    const rebinding = await app.inject({ url: '/api/libraries', headers: { host: 'attacker.example' } });
    expect(rebinding.statusCode).toBe(421);
  });

  it('rejects path-like and malformed parameters', async () => {
    await setup();
    expect((await app.inject({ url: '/api/folders?library=main&folder=../..' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/assets?library=main&folder=/etc' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/assets?library=nope' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/assets/abc/file' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/assets/999999/file' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/assets?cursor=1;DROP' })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/../../etc/passwd' })).statusCode).toBe(404);
  });
});

describe('live updates', () => {
  it('picks up newly generated files via the file watcher without a restart', async () => {
    env = await makeEnv();
    // A second indexer with watching + background worker enabled, like production.
    const live = new Indexer(env.cfg, env.db, { info() {}, warn() {}, error() {} });
    const changes: unknown[] = [];
    live.on('change', (e) => changes.push(e));
    await live.start({ watch: true, worker: true });
    try {
      await new Promise((r) => setTimeout(r, 300));
      await makePng(path.join(env.lib('main'), 'ComfyUI_00001_.png'), { text: { prompt: fixture('sdxl-basic.prompt.json') } });
      const deadline = Date.now() + 15_000;
      let row;
      while (Date.now() < deadline) {
        row = env.db.get<{ index_state: string; has_gen_meta: number }>(
          "SELECT * FROM assets WHERE rel_path = 'ComfyUI_00001_.png' AND status = 'ready'");
        if (row?.index_state === 'done') break;
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(row).toMatchObject({ index_state: 'done', has_gen_meta: 1 });
      // Change events are debounced; browsers get them shortly after.
      await new Promise((r) => setTimeout(r, 700));
      expect(changes.length).toBeGreaterThan(0);

      fs.rmSync(path.join(env.lib('main'), 'ComfyUI_00001_.png'));
      const deadline2 = Date.now() + 10_000;
      while (Date.now() < deadline2 && env.db.get("SELECT 1 FROM assets WHERE status = 'ready'")) {
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(env.db.get("SELECT 1 FROM assets WHERE status = 'ready'")).toBeUndefined();
    } finally {
      await live.stop();
    }
  });
});
