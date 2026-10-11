import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app.js';
import { hashPassphrase } from '../src/server/unlock.js';
import { ageAll, makeEnv, makePng, type Env } from './helpers.js';

const PASS = 'correct horse battery';
let passphraseHash: string;

let env: Env;
let app: FastifyInstance;
afterEach(async () => {
  vi.useRealTimers();
  await app?.close();
  await env?.close();
  env = undefined!;
  app = undefined!;
});

async function setup(hidden: Record<string, unknown> | null = {}) {
  passphraseHash ??= await hashPassphrase(PASS);
  env = await makeEnv([{ id: 'main', writable: true }], hidden ? { hidden: { passphraseHash, ...hidden } } : {});
  app = await buildApp({ cfg: env.cfg, db: env.db, indexer: env.indexer, trash: env.trash, webRoot: null });
  await makePng(path.join(env.lib('main'), 'f', 'public.png'), { color: '#111111' });
  await makePng(path.join(env.lib('main'), 'f', 'secret.png'), { color: '#222222' });
  ageAll(env.root);
  // The secret one is newest, so it would be the folder cover.
  const t = new Date(Date.now() - 1000);
  fs.utimesSync(path.join(env.lib('main'), 'f', 'public.png'), new Date(t.getTime() - 5000), new Date(t.getTime() - 5000));
  await env.sync();
  const id = (name: string) => env.db.get<{ id: number }>('SELECT id FROM assets WHERE name = ?', name)!.id;
  return { pub: id('public.png'), secret: id('secret.png') };
}

async function csrf(): Promise<string> {
  return (await app.inject({ url: '/api/session' })).json().csrf;
}

async function post(url: string, body: unknown = {}, cookie?: string) {
  return app.inject({
    method: 'POST', url, payload: body as object,
    headers: { 'x-csrf-token': await csrf(), 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
  });
}

const get = (url: string, cookie?: string) => app.inject({ url, headers: cookie ? { cookie } : {} });
const names = async (url: string, cookie?: string) => (await get(url, cookie)).json().items.map((x: { name: string }) => x.name).sort();

async function unlockCookie(): Promise<string> {
  const r = await post('/api/unlock', { passphrase: PASS });
  expect(r.statusCode).toBe(200);
  const set = String(r.headers['set-cookie']);
  expect(set).toMatch(/HttpOnly/);
  expect(set).toMatch(/SameSite=Strict/);
  expect(set).toMatch(/Max-Age=900/);
  return set.split(';')[0];
}

describe('hidden assets', () => {
  it('are left out of lists and refused while locked, and shown once unlocked', async () => {
    const { pub, secret } = await setup();
    expect((await get('/api/session')).json()).toMatchObject({ hiddenEnabled: true, unlockedForMs: 0, unlockMinutes: 15 });

    // Hiding works while locked; the asset then leaves every view.
    const hid = await post(`/api/assets/${secret}/hidden`, { hidden: true });
    expect(hid.json()).toMatchObject({ hidden: true });
    expect(await names('/api/assets')).toEqual(['public.png']);
    expect((await get('/api/assets')).json().total).toBe(1);
    expect((await get('/api/libraries')).json().libraries[0].count).toBe(1);
    const folders = (await get('/api/folders?library=main')).json().folders;
    expect(folders).toMatchObject([{ path: 'f', count: 1, cover: { id: pub } }]);
    for (const p of ['', '/metadata', '/thumb', '/file', '/raw/prompt', '/caption']) {
      const r = await get(`/api/assets/${secret}${p}`);
      expect(r.statusCode, p).toBe(404);
      expect(r.headers['cache-control'], p).toBe('no-store');
    }
    expect((await post(`/api/assets/${secret}/hidden`, { hidden: false })).statusCode).toBe(404);
    expect((await post(`/api/assets/${secret}/favorite`, { favorite: true })).statusCode).toBe(404);
    expect((await post(`/api/assets/${secret}/trash`)).statusCode).toBe(404);

    const cookie = await unlockCookie();
    expect((await get('/api/session', cookie)).json().unlockedForMs).toBeGreaterThan(890_000);
    expect(await names('/api/assets', cookie)).toEqual(['public.png', 'secret.png']);
    expect((await get('/api/libraries', cookie)).json().libraries[0].count).toBe(2);
    // Covers never use a hidden asset, even unlocked.
    expect((await get('/api/folders?library=main', cookie)).json().folders).toMatchObject([{ count: 2, cover: { id: pub } }]);
    const asset = (await get(`/api/assets/${secret}`, cookie)).json();
    expect(asset).toMatchObject({ hidden: true });
    expect(asset.v).toMatch(/h$/);

    // Hidden media may only be cached until the unlock ends.
    const thumb = await get(`/api/assets/${secret}/thumb`, cookie);
    expect(thumb.statusCode).toBe(200);
    const maxAge = Number(/max-age=(\d+)/.exec(String(thumb.headers['cache-control']))![1]);
    expect(maxAge).toBeGreaterThan(890);
    expect(maxAge).toBeLessThanOrEqual(900);
    expect(thumb.headers['cache-control']).not.toMatch(/immutable/);
    expect((await get(`/api/assets/${pub}/thumb`)).headers['cache-control']).toMatch(/max-age=31536000, immutable/);
    expect((await get(`/api/assets/${secret}/file`, cookie)).statusCode).toBe(200);

    // Unhiding needs the unlock.
    expect((await post(`/api/assets/${secret}/hidden`, { hidden: false }, cookie)).json()).toMatchObject({ hidden: false });
    expect(await names('/api/assets')).toEqual(['public.png', 'secret.png']);
  });

  it('stays hidden in the trash, and after a move', async () => {
    const { secret } = await setup();
    await post(`/api/assets/${secret}/hidden`, { hidden: true });
    const cookie = await unlockCookie();
    expect((await post(`/api/assets/${secret}/trash`, {}, cookie)).statusCode).toBe(200);
    expect((await get('/api/trash')).json().items).toEqual([]);
    expect((await get('/api/status')).json().trash).toBe(0);
    expect((await get('/api/trash', cookie)).json().items).toHaveLength(1);
    expect((await post(`/api/trash/${secret}/restore`)).statusCode).toBe(404);
    expect((await post(`/api/trash/${secret}/restore`, {}, cookie)).statusCode).toBe(200);

    fs.mkdirSync(path.join(env.lib('main'), 'g'));
    fs.renameSync(path.join(env.lib('main'), 'f', 'secret.png'), path.join(env.lib('main'), 'g', 'renamed.png'));
    await env.sync();
    const row = env.db.get<{ id: number; rel_path: string; hidden: number }>("SELECT * FROM assets WHERE name = 'renamed.png' AND status = 'ready'")!;
    expect(row).toMatchObject({ id: secret, rel_path: 'g/renamed.png', hidden: 1 });
    expect(await names('/api/assets')).toEqual(['public.png']);
  });

  it('rejects wrong passphrases, forged or expired cookies, and slows down guessing', async () => {
    const { secret } = await setup({ unlockMinutes: 1 });
    await post(`/api/assets/${secret}/hidden`, { hidden: true });
    expect((await post('/api/unlock', { passphrase: 'nope' })).statusCode).toBe(403);
    expect((await post('/api/unlock', {})).statusCode).toBe(400);

    const cookie = (await post('/api/unlock', { passphrase: PASS })).headers['set-cookie'] as string;
    const value = cookie.split(';')[0].split('=')[1];
    const [exp, sig] = value.split('.');
    const forged = `wg_unlock=${Number(exp) + 3600_000}.${sig}`;
    expect((await get(`/api/assets/${secret}`, forged)).statusCode).toBe(404);
    expect((await get(`/api/assets/${secret}`, `wg_unlock=${value}`)).statusCode).toBe(200);

    // Lock clears the cookie.
    const locked = await post('/api/lock', {}, `wg_unlock=${value}`);
    expect(String(locked.headers['set-cookie'])).toMatch(/^wg_unlock=; Max-Age=0/);
    expect(locked.json().unlockedForMs).toBe(0);

    // The unlock expires on the server, whatever the browser does with the cookie.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 });
    expect((await get(`/api/assets/${secret}`, `wg_unlock=${value}`)).statusCode).toBe(404);
    vi.useRealTimers();

    // A success resets the count; five failures in a row make the next attempt wait.
    for (let i = 0; i < 5; i++) expect((await post('/api/unlock', { passphrase: 'nope' })).statusCode).toBe(403);
    const limited = await post('/api/unlock', { passphrase: PASS });
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('cannot be unlocked when no passphrase is configured', async () => {
    await setup(null);
    expect((await get('/api/session')).json()).toMatchObject({ hiddenEnabled: false });
    expect((await post('/api/unlock', { passphrase: PASS })).statusCode).toBe(409);
  });
});
