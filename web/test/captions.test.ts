import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app.js';
import { effectiveStatus } from '../src/server/captions.js';
import type { AssetRow } from '../src/server/db.js';
import { Indexer } from '../src/server/indexer.js';
import { ageAll, makeEnv, makeJpeg, makePng, type Env } from './helpers.js';

let env: Env;
let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  await env?.close();
  env = undefined!;
  app = undefined;
});

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const one = (e: Env, rel: string) => e.db.get<AssetRow>("SELECT * FROM assets WHERE rel_path = ? AND status = 'ready'", rel)!;

function captionJson(caption: string, extra: Record<string, unknown> = {}) {
  return {
    schema: 'wandering-lora/caption@1',
    image: 'cat.jpg',
    status: 'generated',
    caption_sha256: sha(caption),
    caption,
    tags: caption.split(', '),
    description: 'A cat on a sofa.',
    classification: { view: 'side', face_visible: true },
    raw: { output: 'verbatim', dropped_tags: [] },
    generation: { model: 'Qwen/Qwen3.5-4B', created_at: '2026-10-10T05:30:00Z' },
    candidate: null,
    previous: null,
    updated_at: '2026-10-10T05:30:00Z',
    ...extra,
  };
}

/** Writes `<dir>/<stem>.txt` and `<stem>.caption.json` the way the pipeline does. */
function writeSidecars(dir: string, stem: string, caption: string, extra: Record<string, unknown> = {}) {
  fs.writeFileSync(path.join(dir, `${stem}.txt`), caption);
  fs.writeFileSync(path.join(dir, `${stem}.caption.json`), JSON.stringify(captionJson(caption, extra), null, 2));
}

async function setup(libs?: Parameters<typeof makeEnv>[0]) {
  env = await makeEnv(libs);
  app = await buildApp({ cfg: env.cfg, db: env.db, indexer: env.indexer, trash: env.trash, webRoot: null });
}

async function post(url: string, body: unknown) {
  const csrf = (await app!.inject({ url: '/api/session' })).json().csrf;
  return app!.inject({ method: 'POST', url, payload: body as object, headers: { 'x-csrf-token': csrf, 'content-type': 'application/json' } });
}

const getCaption = async (id: number) => (await app!.inject({ url: `/api/assets/${id}/caption` })).json();
const act = (id: number, loaded: { updated_at: string | null; txt_sha256: string | null }, body: Record<string, unknown>) =>
  post(`/api/assets/${id}/caption`, { updated_at: loaded.updated_at, txt_sha256: loaded.txt_sha256, ...body });

describe('caption sidecar indexing', () => {
  it('indexes sidecars on scan without listing them as assets, and tracks add/change/remove', async () => {
    env = await makeEnv();
    const dir = env.lib('main');
    await makeJpeg(path.join(dir, 'cat.jpg'));
    await makePng(path.join(dir, 'dog.png'));
    writeSidecars(dir, 'cat', 'siggraph, cat, sofa');
    // Unrelated files: notes without a media stem and a ComfyUI workflow export.
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello');
    fs.writeFileSync(path.join(dir, 'workflow.json'), '{}');
    ageAll(env.root);
    await env.sync();

    const rows = env.db.all<AssetRow>("SELECT * FROM assets WHERE status = 'ready' ORDER BY rel_path");
    expect(rows.map((r) => r.rel_path)).toEqual(['cat.jpg', 'dog.png']);
    const cat = one(env, 'cat.jpg');
    expect(env.db.caption(cat.id)).toMatchObject({
      caption: 'siggraph, cat, sofa', caption_status: 'generated', has_candidate: 0, json_updated_at: '2026-10-10T05:30:00Z',
    });
    expect(JSON.parse(env.db.caption(cat.id)!.classification_json!)).toEqual({ view: 'side', face_visible: true });
    expect(env.db.caption(one(env, 'dog.png').id)).toBeUndefined();

    // Rescan without changes is a no-op.
    const rev = env.db.caption(cat.id)!.rev;
    await env.sync();
    expect(env.db.caption(cat.id)!.rev).toBe(rev);

    // A .txt edited by another tool no longer matches caption_sha256 -> edited; a candidate shows up.
    fs.writeFileSync(path.join(dir, 'cat.txt'), 'siggraph, cat, sofa, sleeping');
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'cat.caption.json'), 'utf8'));
    j.candidate = { caption: 'siggraph, cat' };
    fs.writeFileSync(path.join(dir, 'cat.caption.json'), JSON.stringify(j));
    // A .txt alone (no json) is still a caption.
    fs.writeFileSync(path.join(dir, 'dog.txt'), 'dog, grass');
    await env.sync();
    expect(env.db.caption(cat.id)).toMatchObject({ caption: 'siggraph, cat, sofa, sleeping', caption_status: 'edited', has_candidate: 1 });
    expect(env.db.caption(one(env, 'dog.png').id)).toMatchObject({ caption: 'dog, grass', caption_status: 'edited', json_updated_at: null });

    fs.rmSync(path.join(dir, 'cat.txt'));
    fs.rmSync(path.join(dir, 'cat.caption.json'));
    await env.sync();
    expect(env.db.caption(cat.id)).toBeUndefined();
  });

  it('picks up sidecar changes from the file watcher and reports them', async () => {
    env = await makeEnv();
    const dir = env.lib('main');
    await makeJpeg(path.join(dir, 'cat.jpg'));
    ageAll(env.root);
    await env.sync();
    const id = one(env, 'cat.jpg').id;
    const live = new Indexer(env.cfg, env.db, { info() {}, warn() {}, error() {} });
    const changes: { captions: number[] }[] = [];
    live.on('change', (e) => changes.push(e));
    await live.start({ watch: true, worker: false });
    try {
      await new Promise((r) => setTimeout(r, 300));
      writeSidecars(dir, 'cat', 'siggraph, cat');
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !changes.some((c) => c.captions.includes(id))) await new Promise((r) => setTimeout(r, 100));
      expect(changes.some((c) => c.captions.includes(id))).toBe(true);
      expect(env.db.caption(id)?.caption).toBe('siggraph, cat');

      fs.rmSync(path.join(dir, 'cat.txt'));
      fs.rmSync(path.join(dir, 'cat.caption.json'));
      const deadline2 = Date.now() + 10_000;
      while (Date.now() < deadline2 && env.db.caption(id)) await new Promise((r) => setTimeout(r, 100));
      expect(env.db.caption(id)).toBeUndefined();
      expect(env.db.all("SELECT * FROM assets WHERE status = 'ready'")).toHaveLength(1);
    } finally {
      await live.stop();
    }
  });
});

describe('caption API', () => {
  it('reads, saves, approves and marks for regeneration, preserving unknown keys', async () => {
    await setup();
    const dir = env.lib('main');
    await makeJpeg(path.join(dir, 'cat.jpg'));
    writeSidecars(dir, 'cat', 'siggraph, cat', { custom_key: { keep: [1, 2] } });
    ageAll(env.root);
    await env.sync();
    const id = one(env, 'cat.jpg').id;

    let c = await getCaption(id);
    expect(c).toMatchObject({ txt: 'siggraph, cat', status: 'generated', writable: true, updated_at: '2026-10-10T05:30:00Z', txt_sha256: sha('siggraph, cat') });
    expect(c.json.description).toBe('A cat on a sofa.');

    // Save: normalised to one line, json updated, unknown keys kept.
    let r = await act(id, c, { action: 'save', caption: '  siggraph,   cat,\n lying  ' });
    expect(r.statusCode).toBe(200);
    c = r.json();
    expect(fs.readFileSync(path.join(dir, 'cat.txt'), 'utf8')).toBe('siggraph, cat, lying');
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'cat.caption.json'), 'utf8'));
    expect(j).toMatchObject({
      status: 'edited', caption: 'siggraph, cat, lying', tags: ['siggraph', 'cat', 'lying'], caption_sha256: sha('siggraph, cat, lying'),
      custom_key: { keep: [1, 2] }, schema: 'wandering-lora/caption@1', review: { by: 'gallery' },
    });
    expect(j.updated_at).not.toBe('2026-10-10T05:30:00Z');
    expect(c.status).toBe('edited');
    // No temp files left behind.
    expect(fs.readdirSync(dir).sort()).toEqual(['cat.caption.json', 'cat.jpg', 'cat.txt']);
    // The cache was updated immediately, and the list exposes it.
    expect(env.db.caption(id)).toMatchObject({ caption_status: 'edited' });
    const items = (await app!.inject({ url: '/api/assets' })).json().items;
    expect(items[0]).toMatchObject({ caption: 'edited', captionCandidate: false });

    r = await act(id, c, { action: 'approve' });
    expect(r.json().status).toBe('approved');
    c = r.json();
    r = await act(id, c, { action: 'needs_regen' });
    expect(r.json().status).toBe('needs_regen');
    c = r.json();
    r = await act(id, c, { action: 'save', caption: 'siggraph, cat', approve: true });
    expect(r.json()).toMatchObject({ status: 'approved', txt: 'siggraph, cat' });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'cat.caption.json'), 'utf8')).custom_key).toEqual({ keep: [1, 2] });

    // Re-indexing after our own writes changes nothing.
    const rev = env.db.caption(id)!.rev;
    await env.sync();
    expect(env.db.caption(id)!.rev).toBe(rev);
  });

  it('accepts and discards candidates', async () => {
    await setup();
    const dir = env.lib('main');
    await makeJpeg(path.join(dir, 'cat.jpg'));
    const candidate = { caption: 'siggraph, cat, window', description: 'New description.', classification: { view: 'front' } };
    writeSidecars(dir, 'cat', 'siggraph, cat', { status: 'approved', candidate });
    ageAll(env.root);
    await env.sync();
    const id = one(env, 'cat.jpg').id;
    expect((await app!.inject({ url: '/api/assets?caption=candidate' })).json().total).toBe(1);

    let c = await getCaption(id);
    let r = await act(id, c, { action: 'accept_candidate' });
    expect(r.statusCode).toBe(200);
    c = r.json();
    expect(c).toMatchObject({ txt: 'siggraph, cat, window', status: 'edited' });
    expect(c.json).toMatchObject({
      candidate: null, description: 'New description.', classification: { view: 'front' },
      previous: { caption: 'siggraph, cat', status: 'approved' },
    });
    expect((await app!.inject({ url: '/api/assets?caption=candidate' })).json().total).toBe(0);

    fs.writeFileSync(path.join(dir, 'cat.caption.json'), JSON.stringify({ ...c.json, candidate }));
    c = await getCaption(id);
    r = await act(id, c, { action: 'discard_candidate' });
    expect(r.json().json.candidate).toBeNull();
    expect(r.json().txt).toBe('siggraph, cat, window');
  });

  it('returns 409 when either sidecar changed since it was loaded', async () => {
    await setup();
    const dir = env.lib('main');
    await makeJpeg(path.join(dir, 'cat.jpg'));
    writeSidecars(dir, 'cat', 'siggraph, cat');
    ageAll(env.root);
    await env.sync();
    const id = one(env, 'cat.jpg').id;
    const c = await getCaption(id);

    // The pipeline rewrote the json meanwhile.
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'cat.caption.json'), 'utf8'));
    fs.writeFileSync(path.join(dir, 'cat.caption.json'), JSON.stringify({ ...j, updated_at: '2026-10-11T00:00:00Z' }));
    let r = await act(id, c, { action: 'save', caption: 'mine' });
    expect(r.statusCode).toBe(409);
    expect(fs.readFileSync(path.join(dir, 'cat.txt'), 'utf8')).toBe('siggraph, cat');

    // Someone edited the .txt.
    const c2 = await getCaption(id);
    fs.writeFileSync(path.join(dir, 'cat.txt'), 'other edit');
    r = await act(id, c2, { action: 'approve' });
    expect(r.statusCode).toBe(409);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'cat.caption.json'), 'utf8')).status).toBe('generated');

    // Bad requests.
    expect((await act(id, await getCaption(id), { action: 'explode' })).statusCode).toBe(400);
    expect((await act(id, await getCaption(id), { action: 'save', caption: '   ' })).statusCode).toBe(400);
  });

  it('creates a json next to a bare .txt, and refuses writes in read-only libraries', async () => {
    await setup([{ id: 'rw' }, { id: 'ro', writable: false }]);
    await makePng(path.join(env.lib('rw'), 'a.png'));
    fs.writeFileSync(path.join(env.lib('rw'), 'a.txt'), 'plain caption');
    await makePng(path.join(env.lib('ro'), 'b.png'), { color: '#ff0000' });
    writeSidecars(env.lib('ro'), 'b', 'locked, caption');
    ageAll(env.root);
    await env.sync();

    const a = one(env, 'a.png').id;
    let c = await getCaption(a);
    expect(c).toMatchObject({ txt: 'plain caption', json: null, status: 'edited', updated_at: null });
    const r = await act(a, c, { action: 'approve' });
    expect(r.statusCode).toBe(200);
    c = r.json();
    expect(c.json).toMatchObject({ schema: 'wandering-lora/caption@1', image: 'a.png', status: 'approved', caption: 'plain caption', caption_sha256: sha('plain caption') });
    expect(c.json.image_sha256).toMatch(/^[0-9a-f]{64}$/);

    const b = one(env, 'b.png').id;
    const cb = await getCaption(b);
    expect(cb.writable).toBe(false);
    const rb = await act(b, cb, { action: 'save', caption: 'nope' });
    expect(rb.statusCode).toBe(403);
    expect(fs.readFileSync(path.join(env.lib('ro'), 'b.txt'), 'utf8')).toBe('locked, caption');
  });

  it('filters the asset list by caption status', async () => {
    await setup();
    const dir = env.lib('main');
    for (const n of ['g', 'e', 'a', 'r', 'none']) await makePng(path.join(dir, `${n}.png`), { color: `#${n.length}0${n.charCodeAt(0).toString(16)}00` });
    writeSidecars(dir, 'g', 'x');
    writeSidecars(dir, 'e', 'x', { status: 'edited' });
    writeSidecars(dir, 'a', 'x', { status: 'approved', candidate: { caption: 'y' } });
    writeSidecars(dir, 'r', 'x', { status: 'needs_regen' });
    ageAll(env.root);
    await env.sync();
    const names = async (f: string) =>
      (await app!.inject({ url: `/api/assets?caption=${f}` })).json().items.map((i: { name: string }) => i.name).sort();
    expect(await names('any')).toEqual(['a.png', 'e.png', 'g.png', 'r.png']);
    expect(await names('none')).toEqual(['none.png']);
    expect(await names('generated')).toEqual(['g.png']);
    expect(await names('edited')).toEqual(['e.png']);
    expect(await names('approved')).toEqual(['a.png']);
    expect(await names('needs_regen')).toEqual(['r.png']);
    expect(await names('candidate')).toEqual(['a.png']);
    expect((await app!.inject({ url: '/api/assets?caption=bogus' })).statusCode).toBe(400);
    expect((await app!.inject({ url: '/api/assets?caption=any' })).json().total).toBe(4);
  });
});

describe('caption sidecars in the trash', () => {
  it('moves sidecars with the file and restores them', async () => {
    env = await makeEnv();
    const dir = env.lib('main');
    await makeJpeg(path.join(dir, 'cat.jpg'));
    writeSidecars(dir, 'cat', 'siggraph, cat');
    ageAll(env.root);
    await env.sync();
    const id = one(env, 'cat.jpg').id;

    const trashed = await env.trash.trash(id);
    const tdir = path.dirname(path.join(env.trash.root, trashed.trash_path!));
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(fs.readdirSync(tdir).sort()).toEqual(['cat.caption.json', 'cat.jpg', 'cat.txt']);

    // A new file with the same name must not inherit the old caption.
    await makeJpeg(path.join(dir, 'cat.jpg'), '#ff00ff');
    ageAll(env.root);
    await env.sync();
    expect(env.db.caption(one(env, 'cat.jpg').id)).toBeUndefined();

    // Restore goes to a free name, and its sidecars are renamed to match.
    const restored = await env.trash.restore(id);
    expect(restored.rel_path).toBe('cat (restored).jpg');
    expect(fs.readFileSync(path.join(dir, 'cat (restored).txt'), 'utf8')).toBe('siggraph, cat');
    expect(fs.existsSync(path.join(dir, 'cat (restored).caption.json'))).toBe(true);
    expect(fs.existsSync(tdir)).toBe(false);
    expect(env.db.caption(id)).toMatchObject({ caption: 'siggraph, cat', caption_status: 'generated' });
  });

  it('purging deletes the trashed sidecars too', async () => {
    env = await makeEnv();
    const dir = env.lib('main');
    await makeJpeg(path.join(dir, 'cat.jpg'));
    writeSidecars(dir, 'cat', 'siggraph, cat');
    ageAll(env.root);
    await env.sync();
    const trashed = await env.trash.trash(one(env, 'cat.jpg').id);
    const tdir = path.dirname(path.join(env.trash.root, trashed.trash_path!));
    await env.trash.purge(trashed.id);
    expect(fs.existsSync(tdir)).toBe(false);
  });

  it('treats a .txt changed outside the tools as edited, even after approval', () => {
    const json = { status: 'approved', caption_sha256: sha('a, b') };
    expect(effectiveStatus({ txt: 'a, b', txtSha256: sha('a, b'), json })).toBe('approved');
    expect(effectiveStatus({ txt: 'a, c', txtSha256: sha('a, c'), json })).toBe('edited');
    expect(effectiveStatus({ txt: 'a', txtSha256: sha('a'), json: { status: 'needs_regen', caption_sha256: 'x' } })).toBe('needs_regen');
    expect(effectiveStatus({ txt: 'a', txtSha256: sha('a'), json: null })).toBe('edited');
  });
});
