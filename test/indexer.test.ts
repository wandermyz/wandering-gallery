import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssetRow } from '../src/server/db.js';
import { Db } from '../src/server/db.js';
import { fingerprint, looksComplete } from '../src/server/fileinfo.js';
import { thumbPath, ensureThumb } from '../src/server/thumbs.js';
import { age, ageAll, fixture, hasFfmpeg, makeEnv, makeJpeg, makePng, makeVideo, makeWebp, sha, type Env } from './helpers.js';

let env: Env;
afterEach(async () => {
  await env?.close();
  env = undefined!;
});

const live = (e: Env) => e.db.all<AssetRow>("SELECT * FROM assets WHERE status = 'ready' ORDER BY rel_path");

describe('scanning and indexing', () => {
  it('indexes multiple libraries with images and videos, recursively or not', async () => {
    env = await makeEnv([{ id: 'out', writable: true }, { id: 'flat', recursive: false }]);
    await makePng(path.join(env.lib('out'), 'a.png'), { text: { prompt: fixture('sdxl-basic.prompt.json') } });
    await makeJpeg(path.join(env.lib('out'), 'sub', 'deep', 'b.jpg'));
    await makeWebp(path.join(env.lib('out'), 'c.webp'));
    if (hasFfmpeg) makeVideo(path.join(env.lib('out'), 'video', 'v.mp4'));
    fs.writeFileSync(path.join(env.lib('out'), 'notes.txt'), 'ignored');
    await makePng(path.join(env.lib('out'), '.hidden', 'h.png'));
    await makePng(path.join(env.lib('flat'), 'top.png'));
    await makePng(path.join(env.lib('flat'), 'nested', 'skip.png'));
    ageAll(env.root);
    await env.sync();

    const rows = live(env);
    expect(rows.map((r) => `${r.library_id}:${r.rel_path}`)).toEqual([
      'flat:top.png',
      'out:a.png',
      'out:c.webp',
      'out:sub/deep/b.jpg',
      ...(hasFfmpeg ? ['out:video/v.mp4'] : []),
    ].sort((a, b) => a.split(':')[1].localeCompare(b.split(':')[1])));
    const a = rows.find((r) => r.rel_path === 'a.png')!;
    expect(a).toMatchObject({ kind: 'image', folder: '', width: 64, height: 96, has_gen_meta: 1, index_state: 'done' });
    expect(env.db.metadata(a.id)?.prompt_json).toContain('lighthouse');
    expect(rows.find((r) => r.rel_path === 'sub/deep/b.jpg')!.folder).toBe('sub/deep');
    if (hasFfmpeg) {
      const v = rows.find((r) => r.kind === 'video')!;
      expect(v.duration).toBeGreaterThan(0.5);
      expect(v.video_codec).toBe('h264');
    }
  });

  it('detects new, modified and deleted files incrementally', async () => {
    env = await makeEnv();
    const a = path.join(env.lib('main'), 'a.png');
    const b = path.join(env.lib('main'), 'b.png');
    await makePng(a, { color: '#aa0000' });
    await makePng(b, { color: '#00aa00' });
    ageAll(env.root);
    await env.sync();
    const before = live(env);
    expect(before).toHaveLength(2);
    env.db.setRating(before[0].id, 4);

    // Modify a in place (same inode) -> same row, metadata re-read, rating kept.
    const fd = fs.openSync(a, 'r+');
    const replacement = await makePng(path.join(env.root, 'tmp.png'), { w: 10, h: 10, text: { prompt: fixture('sdxl-basic.prompt.json') } });
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, replacement, 0, replacement.length, 0);
    fs.closeSync(fd);
    age(a, 60);
    // Delete b, add c.
    fs.rmSync(b);
    await makePng(path.join(env.lib('main'), 'c.png'), { color: '#0000aa' });
    age(path.join(env.lib('main'), 'c.png'));
    await env.sync();

    const after = live(env);
    expect(after.map((r) => r.rel_path)).toEqual(['a.png', 'c.png']);
    const a2 = after[0];
    expect(a2.id).toBe(before[0].id);
    expect(a2.rating).toBe(4);
    expect(a2.width).toBe(10);
    expect(a2.has_gen_meta).toBe(1);
    expect(env.db.get<AssetRow>('SELECT * FROM assets WHERE id = ?', before[1].id)!.status).toBe('missing');
  });

  it('keeps favorites and ratings across rescans and database reopen', async () => {
    env = await makeEnv();
    await makePng(path.join(env.lib('main'), 'keep.png'));
    ageAll(env.root);
    await env.sync();
    const [row] = live(env);
    env.db.setFavorite(row.id, true);
    env.db.setRating(row.id, 5);
    await env.indexer.scanAll();
    await env.indexer.scanAll();
    // Reopen the database file, as after a restart.
    const db2 = new Db(path.join(env.cfg.dataDir, 'gallery.db'));
    const again = db2.asset(row.id)!;
    db2.close();
    expect(again).toMatchObject({ favorite: 1, rating: 5, status: 'ready' });
  });

  it('carries favorite/rating across a rename or move, but not to unrelated files', async () => {
    env = await makeEnv([{ id: 'main' }, { id: 'other' }]);
    const orig = path.join(env.lib('main'), 'orig.png');
    await makePng(orig, { color: '#112233' });
    ageAll(env.root);
    await env.sync();
    const [row] = live(env);
    env.db.setFavorite(row.id, true);
    env.db.setRating(row.id, 3);

    // Rename within the library and move into a subfolder.
    fs.mkdirSync(path.join(env.lib('main'), 'keepers'));
    fs.renameSync(orig, path.join(env.lib('main'), 'keepers', 'renamed.png'));
    await env.sync();
    let rows = live(env);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: row.id, rel_path: 'keepers/renamed.png', favorite: 1, rating: 3 });

    // Move to another library.
    fs.renameSync(path.join(env.lib('main'), 'keepers', 'renamed.png'), path.join(env.lib('other'), 'x.png'));
    await env.sync();
    rows = live(env);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: row.id, library_id: 'other', rel_path: 'x.png', favorite: 1 });

    // Replace with a *different* file at the same path: must not inherit the rating.
    fs.rmSync(path.join(env.lib('other'), 'x.png'));
    await makePng(path.join(env.lib('other'), 'x.png'), { color: '#ffeedd', w: 70 });
    age(path.join(env.lib('other'), 'x.png'));
    await env.sync();
    rows = live(env);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).not.toBe(row.id);
    expect(rows[0]).toMatchObject({ favorite: 0, rating: 0 });
  });

  it('does not create duplicate rows when the same file is reconciled concurrently', async () => {
    env = await makeEnv();
    const file = path.join(env.lib('main'), 'race.png');
    await makePng(file);
    age(file);
    const state = env.indexer.libs.get('main')!;
    const { statEntry } = await import('../src/server/scanner.js');
    const entry = (await statEntry(state.realRoot!, 'race.png'))!;
    const results = await Promise.all([env.indexer.syncFile(state, entry), env.indexer.syncFile(state, entry), env.indexer.scanLibrary('main')]);
    expect(results.slice(0, 2).sort()).toEqual(['added', 'updated']);
    expect(live(env)).toHaveLength(1);
  });

  it('hands favorite/rating to a copy when the original is deleted after copying (rsync-style move)', async () => {
    env = await makeEnv([{ id: 'main' }, { id: 'other' }]);
    const orig = path.join(env.lib('main'), 'o.png');
    await makePng(orig, { color: '#334455' });
    ageAll(env.root);
    await env.sync();
    const [row] = live(env);
    env.db.setFavorite(row.id, true);
    env.db.setRating(row.id, 5);
    fs.copyFileSync(orig, path.join(env.lib('other'), 'copy.png'));
    age(path.join(env.lib('other'), 'copy.png'));
    await env.sync();
    expect(live(env)).toHaveLength(2);
    fs.rmSync(orig);
    await env.sync();
    const rows = live(env);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ library_id: 'other', favorite: 1, rating: 5 });
  });

  it('keeps pending items of an offline library pending instead of failing them', async () => {
    env = await makeEnv();
    await makePng(path.join(env.lib('main'), 'a.png'));
    ageAll(env.root);
    await env.indexer.scanAll();
    const [row] = live(env);
    env.indexer.libs.get('main')!.realRoot = null; // library went offline
    expect(await env.indexer.indexOne(row)).toBe(false);
    expect(env.db.asset(row.id)!.index_state).toBe('pending');
  });

  it('defers files that are still being written', async () => {
    env = await makeEnv();
    const file = path.join(env.lib('main'), 'gen.png');
    const png = await makePng(path.join(env.root, 'full.png'), { w: 200, h: 200 });
    // Fresh file: within the stability window.
    fs.writeFileSync(file, png.subarray(0, png.length - 20));
    await env.sync();
    expect(live(env)).toHaveLength(0);
    // Old enough, but truncated (no IEND): still deferred.
    age(file, 30);
    expect(await looksComplete(file)).toBe(false);
    await env.sync();
    expect(live(env)).toHaveLength(0);
    // Completed.
    fs.writeFileSync(file, png);
    age(file, 30);
    expect(await looksComplete(file)).toBe(true);
    await env.sync();
    expect(live(env)).toHaveLength(1);
  });

  it.skipIf(!hasFfmpeg)('recognises incomplete MP4 files', async () => {
    env = await makeEnv();
    const file = path.join(env.root, 'v.mp4');
    makeVideo(file);
    expect(await looksComplete(file)).toBe(true);
    const partial = path.join(env.root, 'partial.mp4');
    const buf = fs.readFileSync(file);
    fs.writeFileSync(partial, buf.subarray(0, Math.floor(buf.length * 0.6)));
    expect(await looksComplete(partial)).toBe(false);
  });

  it('shows corrupt files in the gallery with an index error', async () => {
    env = await makeEnv();
    const file = path.join(env.lib('main'), 'broken.jpg');
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from('garbage'), Buffer.from([0xff, 0xd9])]));
    age(file, 3600);
    await env.sync();
    const [row] = live(env);
    expect(row.index_state).toBe('error');
    expect(row.index_error).toBeTruthy();
  });

  it('handles missing library directories gracefully and picks them up later', async () => {
    env = await makeEnv([{ id: 'main' }, { id: 'gone' }]);
    fs.rmSync(env.lib('gone'), { recursive: true });
    await makePng(path.join(env.lib('main'), 'ok.png'));
    ageAll(env.lib('main'));
    // Re-open: the 'gone' library is now unavailable.
    await env.close();
    env = await makeEnv([{ id: 'main' }, { id: 'gone' }]);
    fs.rmSync(env.lib('gone'), { recursive: true });
    const state = env.indexer.libs.get('gone')!;
    await env.indexer.scanAll();
    expect(state.realRoot).toBeNull();
    expect(state.error).toMatch(/unavailable/);
  });

  it('keeps index rows for folders that become unreadable', async () => {
    if (process.getuid?.() === 0) return; // root ignores permissions
    env = await makeEnv();
    const sub = path.join(env.lib('main'), 'locked');
    await makePng(path.join(sub, 'x.png'));
    ageAll(env.root);
    await env.sync();
    fs.chmodSync(sub, 0o000);
    try {
      await env.sync();
      expect(live(env).map((r) => r.rel_path)).toEqual(['locked/x.png']);
    } finally {
      fs.chmodSync(sub, 0o755);
    }
  });

  it('never modifies original files while indexing', async () => {
    env = await makeEnv();
    const files = [path.join(env.lib('main'), 'p.png'), path.join(env.lib('main'), 'q.webp')];
    await makePng(files[0], { text: { prompt: fixture('flux-custom-sampler.prompt.json') } });
    await makeWebp(files[1]);
    ageAll(env.root);
    const before = files.map((f) => [sha(f), fs.statSync(f).mtimeMs]);
    await env.sync();
    for (const r of live(env)) env.db.setRating(r.id, 5);
    await env.sync();
    expect(files.map((f) => [sha(f), fs.statSync(f).mtimeMs])).toEqual(before);
    expect(fs.readdirSync(env.lib('main')).sort()).toEqual(['p.png', 'q.webp']);
  });
});

describe('thumbnails', () => {
  it('generates and caches thumbnails keyed by content', async () => {
    env = await makeEnv();
    const file = path.join(env.lib('main'), 'big.png');
    await makePng(file, { w: 1200, h: 800 });
    const fp = await fingerprint(file);
    const opts = env.indexer.thumbOptions();
    const out = await ensureThumb(file, 'image', fp, opts);
    expect(out).toBe(thumbPath(env.cfg.cacheDir, fp, opts.size));
    const meta = await (await import('sharp')).default(out).metadata();
    expect(meta.format).toBe('webp');
    expect(Math.max(meta.width!, meta.height!)).toBe(opts.size);
    // Second call reuses the cache.
    const mtime = fs.statSync(out).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    await ensureThumb(file, 'image', fp, opts);
    expect(fs.statSync(out).mtimeMs).toBe(mtime);
  });

  it.skipIf(!hasFfmpeg)('generates video thumbnails, including very short clips', async () => {
    env = await makeEnv();
    const file = path.join(env.lib('main'), 'short.mp4');
    makeVideo(file, { seconds: 0.3 });
    const out = await ensureThumb(file, 'video', await fingerprint(file), env.indexer.thumbOptions());
    expect(fs.statSync(out).size).toBeGreaterThan(100);
  });

  it('reports failures without touching the source', async () => {
    env = await makeEnv();
    const file = path.join(env.lib('main'), 'bad.png');
    fs.writeFileSync(file, 'not an image');
    const before = sha(file);
    await expect(ensureThumb(file, 'image', 'deadbeefdeadbeef', env.indexer.thumbOptions())).rejects.toThrow();
    expect(sha(file)).toBe(before);
    expect(fs.existsSync(thumbPath(env.cfg.cacheDir, 'deadbeefdeadbeef', env.cfg.thumbnails.size))).toBe(false);
  });

  it('rejects malformed fingerprints in cache paths', () => {
    expect(() => thumbPath('/c', '../../etc/passwd', 360)).toThrow();
  });
});
