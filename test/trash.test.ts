import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssetRow } from '../src/server/db.js';
import { checkRelPath, HttpError, resolveInside } from '../src/server/paths.js';
import { age, ageAll, fixture, makeEnv, makePng, sha, type Env } from './helpers.js';

let env: Env;
afterEach(async () => {
  await env?.close();
  env = undefined!;
});

const one = (e: Env, rel: string) =>
  e.db.get<AssetRow>("SELECT * FROM assets WHERE rel_path = ? AND status = 'ready'", rel)!;

describe('trash and restore', () => {
  it('moves the real file to the trash, hides it, and restores it with its state', async () => {
    env = await makeEnv();
    const file = path.join(env.lib('main'), 'sub', 'pic.png');
    await makePng(file, { text: { prompt: fixture('sdxl-basic.prompt.json') } });
    ageAll(env.root);
    await env.sync();
    const row = one(env, 'sub/pic.png');
    env.db.setFavorite(row.id, true);
    env.db.setRating(row.id, 4);
    const hash = sha(file);

    const trashed = await env.trash.trash(row.id);
    expect(trashed.status).toBe('trashed');
    expect(fs.existsSync(file)).toBe(false);
    // The folder itself is never removed.
    expect(fs.existsSync(path.dirname(file))).toBe(true);
    const inTrash = path.join(env.trash.root, trashed.trash_path!);
    expect(sha(inTrash)).toBe(hash);

    // A rescan must not resurrect or forget it.
    await env.sync();
    expect(env.db.asset(row.id)!.status).toBe('trashed');
    expect(env.db.all("SELECT * FROM assets WHERE status = 'ready'")).toHaveLength(0);

    const restored = await env.trash.restore(row.id);
    expect(restored).toMatchObject({ status: 'ready', rel_path: 'sub/pic.png', favorite: 1, rating: 4 });
    expect(sha(file)).toBe(hash);
    expect(env.db.metadata(row.id)?.prompt_json).toContain('lighthouse');
    expect(fs.existsSync(inTrash)).toBe(false);
    expect(fs.existsSync(path.dirname(inTrash))).toBe(false);
    await env.sync();
    expect(env.db.asset(row.id)).toMatchObject({ status: 'ready', favorite: 1, rating: 4 });
  });

  it('restores to a new name if the original path is taken again', async () => {
    env = await makeEnv();
    const file = path.join(env.lib('main'), 'a.png');
    await makePng(file, { color: '#000000' });
    ageAll(env.root);
    await env.sync();
    const row = one(env, 'a.png');
    await env.trash.trash(row.id);
    await makePng(file, { color: '#ffffff' });
    age(file);
    await env.sync();
    const restored = await env.trash.restore(row.id);
    expect(restored.rel_path).toBe('a (restored).png');
    expect(fs.readdirSync(env.lib('main')).sort()).toEqual(['a (restored).png', 'a.png']);
  });

  it('never overwrites a file that appears at the restore target during restore', async () => {
    env = await makeEnv();
    const file = path.join(env.lib('main'), 'a.png');
    await makePng(file, { color: '#101010' });
    ageAll(env.root);
    await env.sync();
    const row = one(env, 'a.png');
    await env.trash.trash(row.id);
    // A new generation reuses the name; the scanner has not seen it yet.
    await makePng(file, { color: '#fefefe' });
    const newHash = sha(file);
    const restored = await env.trash.restore(row.id);
    expect(restored.rel_path).toBe('a (restored).png');
    expect(sha(file)).toBe(newHash);
  });

  it('repairs rows left half-trashed by a crash', async () => {
    env = await makeEnv();
    const file = path.join(env.lib('main'), 'a.png');
    await makePng(file);
    ageAll(env.root);
    await env.sync();
    const row = one(env, 'a.png');
    env.db.setRating(row.id, 3);
    // Simulate a crash after recording the trash intent but before the move.
    env.db.run("UPDATE assets SET status = 'trashed', trash_path = 'main/x/a.png', trashed_at_ms = 1 WHERE id = ?", row.id);
    expect(await env.trash.reconcile()).toBe(1);
    expect(env.db.asset(row.id)).toMatchObject({ status: 'ready', rating: 3, trash_path: null });
  });

  it('refuses to delete from read-only libraries', async () => {
    env = await makeEnv([{ id: 'ro', writable: false }]);
    const file = path.join(env.lib('ro'), 'x.png');
    await makePng(file);
    ageAll(env.root);
    await env.sync();
    await expect(env.trash.trash(one(env, 'x.png').id)).rejects.toMatchObject({ status: 403 });
    expect(fs.existsSync(file)).toBe(true);
  });

  it('refuses to delete a file that is still being written', async () => {
    env = await makeEnv();
    const file = path.join(env.lib('main'), 'x.png');
    await makePng(file);
    ageAll(env.root);
    await env.sync();
    // Simulate the generator touching the file again.
    fs.utimesSync(file, new Date(), new Date());
    await expect(env.trash.trash(one(env, 'x.png').id)).rejects.toMatchObject({ status: 409 });
    expect(fs.existsSync(file)).toBe(true);
  });

  it('refuses to delete when the file changed since it was indexed', async () => {
    env = await makeEnv();
    const file = path.join(env.lib('main'), 'x.png');
    await makePng(file);
    ageAll(env.root);
    await env.sync();
    const row = one(env, 'x.png');
    await makePng(file, { w: 300 });
    age(file);
    await expect(env.trash.trash(row.id, { size: row.size, mtimeMs: row.mtime_ms })).rejects.toMatchObject({ status: 409 });
    expect(fs.existsSync(file)).toBe(true);
  });

  it('refuses to delete through a symlink and never touches the target', async () => {
    env = await makeEnv();
    const real = path.join(env.lib('main'), 'real.png');
    await makePng(real);
    fs.symlinkSync(real, path.join(env.lib('main'), 'link.png'));
    ageAll(env.root);
    await env.sync();
    await expect(env.trash.trash(one(env, 'link.png').id)).rejects.toMatchObject({ status: 400 });
    expect(fs.existsSync(real)).toBe(true);
  });

  it('purges permanently, and expires old items after the retention period', async () => {
    env = await makeEnv();
    for (const n of ['a', 'b']) await makePng(path.join(env.lib('main'), `${n}.png`));
    ageAll(env.root);
    await env.sync();
    const a = await env.trash.trash(one(env, 'a.png').id);
    const b = await env.trash.trash(one(env, 'b.png').id);
    await env.trash.purge(a.id);
    expect(env.db.asset(a.id)).toBeUndefined();
    expect(fs.existsSync(path.join(env.trash.root, a.trash_path!))).toBe(false);

    expect(await env.trash.purgeExpired(Date.now() + 6 * 86_400_000)).toBe(0);
    expect(await env.trash.purgeExpired(Date.now() + 8 * 86_400_000)).toBe(1);
    expect(env.db.asset(b.id)).toBeUndefined();
    expect(fs.readdirSync(env.lib('main'))).toEqual([]);
  });

  it('reports a clear error when the trashed file has vanished', async () => {
    env = await makeEnv();
    await makePng(path.join(env.lib('main'), 'a.png'));
    ageAll(env.root);
    await env.sync();
    const t = await env.trash.trash(one(env, 'a.png').id);
    fs.rmSync(path.join(env.trash.root, t.trash_path!));
    await expect(env.trash.restore(t.id)).rejects.toMatchObject({ status: 410 });
  });
});

describe('filesystem boundaries', () => {
  it.each(['../x', 'a/../../x', '/etc/passwd', 'a//b', './a', 'a\\..\\b', 'a\0b', ''])('rejects unsafe relative path %j', (p) => {
    expect(() => checkRelPath(p)).toThrow(HttpError);
  });

  it('blocks symlinks that escape the library', async () => {
    env = await makeEnv();
    const outside = path.join(env.root, 'secret.png');
    await makePng(outside);
    fs.symlinkSync(outside, path.join(env.lib('main'), 'escape.png'));
    fs.symlinkSync(env.root, path.join(env.lib('main'), 'dirlink'));
    ageAll(env.root);
    await env.sync();
    // Neither the escaping file link nor anything behind the directory link is indexed.
    expect(env.db.all("SELECT * FROM assets WHERE status = 'ready'")).toHaveLength(0);
    await expect(resolveInside(env.lib('main'), 'escape.png')).rejects.toMatchObject({ status: 403 });
    await expect(resolveInside(env.lib('main'), 'dirlink/secret.png')).rejects.toMatchObject({ status: 403 });
  });

  it('refuses to restore outside the library even if the database row is tampered with', async () => {
    env = await makeEnv();
    await makePng(path.join(env.lib('main'), 'a.png'));
    ageAll(env.root);
    await env.sync();
    const t = await env.trash.trash(one(env, 'a.png').id);
    env.db.run('UPDATE assets SET rel_path = ? WHERE id = ?', '../../escaped.png', t.id);
    await expect(env.trash.restore(t.id)).rejects.toBeInstanceOf(HttpError);
    env.db.run('UPDATE assets SET rel_path = ?, trash_path = ? WHERE id = ?', 'a.png', '../../../etc/passwd', t.id);
    await expect(env.trash.restore(t.id)).rejects.toBeInstanceOf(HttpError);
  });
});
