import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssetRow } from '../src/server/db.js';
import { Datasets } from '../src/server/datasets.js';
import { HttpError } from '../src/server/paths.js';
import { ageAll, makeEnv, makePng, sha, tmpDir, type Env } from './helpers.js';

let env: Env;
let dsRoot: string;
afterEach(async () => {
  await env?.close();
  env = undefined!;
  fs.rmSync(dsRoot, { recursive: true, force: true });
});

const one = (e: Env, rel: string) =>
  e.db.get<AssetRow>("SELECT * FROM assets WHERE rel_path = ? AND status = 'ready'", rel)!;

async function setup(libs?: Parameters<typeof makeEnv>[0]) {
  dsRoot = tmpDir('wg-ds-');
  env = await makeEnv(libs, { datasets: { root: dsRoot } });
  return new Datasets(env.cfg, env.db, env.indexer, env.trash);
}

async function picWithSidecars(rel: string) {
  const file = path.join(env.lib('main'), rel);
  await makePng(file, {});
  fs.writeFileSync(file.replace(/\.png$/, '.txt'), 'trigger, cat');
  fs.writeFileSync(file.replace(/\.png$/, '.caption.json'), '{"status":"edited"}\n');
  ageAll(env.root);
  await env.sync();
  return file;
}

describe('datasets', () => {
  it('lists first-level folders with their image counts', async () => {
    const ds = await setup();
    fs.mkdirSync(path.join(dsRoot, 'b', 'images'), { recursive: true });
    fs.writeFileSync(path.join(dsRoot, 'b', 'images', 'x.png'), 'x');
    fs.writeFileSync(path.join(dsRoot, 'b', 'images', 'x.txt'), 'x');
    fs.mkdirSync(path.join(dsRoot, 'a'));
    fs.mkdirSync(path.join(dsRoot, '.hidden'));
    fs.writeFileSync(path.join(dsRoot, 'file.txt'), '');
    expect(await ds.list()).toEqual([{ name: 'a', count: 0 }, { name: 'b', count: 1 }]);
  });

  it('copies a file and its sidecars, leaving the original in place', async () => {
    const ds = await setup();
    fs.mkdirSync(path.join(dsRoot, 'cats'));
    const file = await picWithSidecars('sub/pic.png');
    const row = one(env, 'sub/pic.png');
    const r = await ds.add(row.id, 'cats', 'copy');
    expect(r).toMatchObject({ mode: 'copy', created: false, name: 'pic.png', row: null });
    const dest = path.join(dsRoot, 'cats', 'images');
    expect(sha(path.join(dest, 'pic.png'))).toBe(sha(file));
    expect(fs.readFileSync(path.join(dest, 'pic.txt'), 'utf8')).toBe('trigger, cat');
    expect(fs.existsSync(path.join(dest, 'pic.caption.json'))).toBe(true);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(file.replace(/\.png$/, '.txt'))).toBe(true);
    expect(env.db.asset(row.id)!.status).toBe('ready');
  });

  it('moves a file and its sidecars, creating a new dataset only when asked', async () => {
    const ds = await setup();
    const file = await picWithSidecars('pic.png');
    const row = one(env, 'pic.png');
    await expect(ds.add(row.id, 'dogs', 'move')).rejects.toThrow(/no dataset/);
    expect(fs.existsSync(file)).toBe(true);
    const r = await ds.add(row.id, 'dogs', 'move', { create: true });
    expect(r.created).toBe(true);
    const dest = path.join(dsRoot, 'dogs', 'images');
    expect(fs.readdirSync(dest).sort()).toEqual(['pic.caption.json', 'pic.png', 'pic.txt']);
    expect(fs.readdirSync(env.lib('main'))).toEqual([]);
    // Not a library: the row is kept as missing so the rating can follow if it shows up later.
    expect(env.db.asset(row.id)!.status).toBe('missing');
  });

  it('keeps rating and favorite when moving into a folder that is a library', async () => {
    const ds = await setup([{ id: 'main' }, { id: 'set' }]);
    // Point the "set" library at a dataset's images folder.
    const dsImages = path.join(dsRoot, 'set', 'images');
    fs.mkdirSync(path.dirname(dsImages), { recursive: true });
    fs.symlinkSync(env.lib('set'), dsImages);
    await picWithSidecars('pic.png');
    const row = one(env, 'pic.png');
    env.db.setRating(row.id, 4);
    env.db.setFavorite(row.id, true);
    const r = await ds.add(row.id, 'set', 'move');
    expect(r.row).toMatchObject({ id: row.id, library_id: 'set', rel_path: 'pic.png', rating: 4, favorite: 1, status: 'ready' });
    await env.sync();
    expect(env.db.all("SELECT * FROM assets WHERE status = 'ready'")).toHaveLength(1);
    expect(env.db.get<{ caption: string }>('SELECT caption FROM captions WHERE asset_id = ?', row.id)!.caption).toBe('trigger, cat');
  });

  it('asks when the name is taken (counting sidecars), and can keep both', async () => {
    const ds = await setup();
    const dest = path.join(dsRoot, 'cats', 'images');
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'pic.png'), 'other');
    fs.writeFileSync(path.join(dest, 'pic-2.txt'), 'orphan caption');
    await picWithSidecars('pic.png');
    const id = one(env, 'pic.png').id;
    const err = await ds.add(id, 'cats', 'move').catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 409, data: { conflict: { name: 'pic.png', existing: ['pic.png'] } } });
    // Nothing moved.
    expect(fs.existsSync(path.join(env.lib('main'), 'pic.png'))).toBe(true);
    // A sidecar alone also takes the name.
    fs.renameSync(path.join(dest, 'pic.png'), path.join(dest, 'other.png'));
    fs.writeFileSync(path.join(dest, 'pic.caption.json'), '{}');
    expect(await ds.add(id, 'cats', 'copy').catch((e) => e.data)).toEqual({ conflict: { name: 'pic.png', existing: ['pic.caption.json'] } });

    const r = await ds.add(id, 'cats', 'copy', { onConflict: 'rename' });
    expect(r).toMatchObject({ name: 'pic-3.png', replaced: false });
    expect(fs.readFileSync(path.join(dest, 'pic-2.txt'), 'utf8')).toBe('orphan caption');
    expect(fs.readFileSync(path.join(dest, 'pic-3.txt'), 'utf8')).toBe('trigger, cat');
  });

  it('replace sends loose files of that name to the trash', async () => {
    const ds = await setup();
    const dest = path.join(dsRoot, 'cats', 'images');
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'pic.png'), 'old image');
    fs.writeFileSync(path.join(dest, 'pic.txt'), 'old caption');
    const file = await picWithSidecars('pic.png');
    const hash = sha(file);
    const r = await ds.add(one(env, 'pic.png').id, 'cats', 'move', { onConflict: 'replace' });
    expect(r).toMatchObject({ name: 'pic.png', replaced: true });
    expect(sha(path.join(dest, 'pic.png'))).toBe(hash);
    expect(fs.readFileSync(path.join(dest, 'pic.txt'), 'utf8')).toBe('trigger, cat');
    expect(fs.existsSync(path.join(dest, 'pic.caption.json'))).toBe(true);
    const stashDir = path.join(env.trash.root, '_replaced');
    const [stash] = fs.readdirSync(stashDir);
    expect(fs.readdirSync(path.join(stashDir, stash)).sort()).toEqual(['pic.png', 'pic.txt']);
    expect(fs.readFileSync(path.join(stashDir, stash, 'pic.txt'), 'utf8')).toBe('old caption');
    // Expires with the trash retention.
    await env.trash.purgeExpired(Date.now() + 8 * 86_400_000);
    expect(fs.readdirSync(stashDir)).toEqual([]);
  });

  it('replace trashes an indexed asset so it can be restored with its rating', async () => {
    const ds = await setup([{ id: 'main' }, { id: 'set' }]);
    const dsImages = path.join(dsRoot, 'set', 'images');
    fs.mkdirSync(path.dirname(dsImages), { recursive: true });
    fs.symlinkSync(env.lib('set'), dsImages);
    await makePng(path.join(env.lib('set'), 'pic.png'), { color: '#123456' });
    await picWithSidecars('pic.png');
    const old = env.db.get<AssetRow>("SELECT * FROM assets WHERE library_id = 'main' AND status = 'ready'")!;
    const oldInSet = env.db.get<AssetRow>("SELECT * FROM assets WHERE library_id = 'set' AND status = 'ready'")!;
    env.db.setRating(oldInSet.id, 5);
    const r = await ds.add(old.id, 'set', 'move', { onConflict: 'replace' });
    expect(r.replaced).toBe(true);
    expect(r.row).toMatchObject({ id: old.id, library_id: 'set', rel_path: 'pic.png' });
    expect(env.db.asset(oldInSet.id)).toMatchObject({ status: 'trashed', rating: 5 });
    const restored = await env.trash.restore(oldInSet.id);
    expect(restored).toMatchObject({ status: 'ready', rel_path: 'pic (restored).png', rating: 5 });
  });

  it('only copies from read-only libraries, and rejects bad names', async () => {
    const ds = await setup([{ id: 'main', writable: false }]);
    fs.mkdirSync(path.join(dsRoot, 'cats'));
    await picWithSidecars('pic.png');
    const id = one(env, 'pic.png').id;
    await expect(ds.add(id, 'cats', 'move')).rejects.toThrow(/read-only/);
    for (const bad of ['../x', '.wlora', 'a/b', '', '..']) {
      await expect(ds.add(id, bad, 'copy', { create: true })).rejects.toBeInstanceOf(HttpError);
    }
    expect(fs.readdirSync(dsRoot)).toEqual(['cats']);
    expect((await ds.add(id, 'cats', 'copy')).name).toBe('pic.png');
  });

  it('refuses a stale request', async () => {
    const ds = await setup();
    fs.mkdirSync(path.join(dsRoot, 'cats'));
    await picWithSidecars('pic.png');
    const row = one(env, 'pic.png');
    await expect(ds.add(row.id, 'cats', 'move', { expected: { size: row.size + 1 } })).rejects.toThrow(/changed/);
  });
});
