import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { buildApp } from '../src/server/app.js';
import { markdownRefs, markdownSummary, resolveRef } from '../src/server/markdown.js';
import { hashPassphrase } from '../src/server/unlock.js';
import { ageAll, makeEnv, makePng, type Env } from './helpers.js';

const PASS = 'correct horse battery';
let passphraseHash: string;

let env: Env;
let app: FastifyInstance;
afterEach(async () => {
  await app?.close();
  await env?.close();
  env = undefined!;
  app = undefined!;
});

const STORY = `# 海边的信

She waited by the sea.

![The beach](beach.png "At dusk")

![](./secret.png) and [the beach](beach%20copy.png) and [docs](https://example.com/x.png)

<video src="clip.mp4" controls></video>

![gone](missing.png) ![out](../../etc/passwd) ![root](/f/beach.png)
`;

async function setup() {
  passphraseHash ??= await hashPassphrase(PASS);
  env = await makeEnv([{ id: 'main', writable: true }], { hidden: { passphraseHash } });
  app = await buildApp({ cfg: env.cfg, db: env.db, indexer: env.indexer, trash: env.trash, webRoot: null });
  const dir = path.join(env.lib('main'), 'f');
  await makePng(path.join(dir, 'beach.png'), { color: '#5566aa' });
  await makePng(path.join(dir, 'secret.png'), { color: '#222222' });
  fs.writeFileSync(path.join(dir, 'story.md'), STORY);
  // A sidecar caption of beach.png's namesake must stay with the image.
  await makePng(path.join(dir, 'story.png'), { color: '#333333' });
  fs.writeFileSync(path.join(dir, 'story.txt'), 'a caption');
  ageAll(env.root);
  await env.sync();
  const id = (name: string) => env.db.get<{ id: number }>("SELECT id FROM assets WHERE name = ? AND status = 'ready'", name)!.id;
  return { story: id('story.md'), beach: id('beach.png'), secret: id('secret.png'), storyPng: id('story.png') };
}

async function post(url: string, body: unknown = {}, cookie?: string) {
  const csrf = (await app.inject({ url: '/api/session' })).json().csrf;
  return app.inject({
    method: 'POST', url, payload: body as object,
    headers: { 'x-csrf-token': csrf, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
  });
}
const get = (url: string, cookie?: string) => app.inject({ url, headers: cookie ? { cookie } : {} });

describe('markdown helpers', () => {
  it('collects references from Markdown and raw HTML', () => {
    expect(markdownRefs(STORY).sort()).toEqual([
      '../../etc/passwd', './secret.png', '/f/beach.png', 'beach%20copy.png', 'beach.png', 'clip.mp4',
      'https://example.com/x.png', 'missing.png',
    ]);
  });

  it('resolves references inside the library only', () => {
    expect(resolveRef('beach.png', 'f')).toBe('f/beach.png');
    expect(resolveRef('./a%20b.png?x=1#y', 'f')).toBe('f/a b.png');
    expect(resolveRef('../g/c.png', 'f')).toBe('g/c.png');
    expect(resolveRef('/f/beach.png', 'g')).toBe('f/beach.png');
    expect(resolveRef('../../x.png', 'f')).toBeNull();
    expect(resolveRef('https://example.com/a.png', 'f')).toBeNull();
    expect(resolveRef('//example.com/a.png', 'f')).toBeNull();
    expect(resolveRef('#top', 'f')).toBeNull();
    expect(resolveRef('data:image/png;base64,xx', 'f')).toBeNull();
  });

  it('summarises title and text', () => {
    expect(markdownSummary(STORY)).toMatchObject({ title: '海边的信' });
    expect(markdownSummary(STORY).body).toContain('She waited by the sea.');
  });
});

describe('markdown assets', () => {
  it('are indexed as documents with a text-card thumbnail and searchable text', async () => {
    const { story } = await setup();
    const a = (await get(`/api/assets/${story}`)).json();
    expect(a).toMatchObject({ kind: 'markdown', mime: 'text/markdown; charset=utf-8', indexState: 'done', caption: null });
    expect((await get('/api/assets?kind=markdown')).json().items.map((x: { name: string }) => x.name)).toEqual(['story.md']);
    expect((await get('/api/libraries')).json().libraries[0]).toMatchObject({ documents: 1, images: 3 });
    const thumb = await get(`/api/assets/${story}/thumb`);
    expect(thumb.statusCode).toBe(200);
    expect((await sharp(thumb.rawPayload).metadata()).format).toBe('webp');
    expect(env.db.metadata(story)?.search_text).toContain('she waited by the sea');
    expect((await get(`/api/assets/${story}/caption`)).statusCode).toBe(400);
  });

  it('resolves embedded media, hiding hidden assets while locked', async () => {
    const { story, beach, secret } = await setup();
    let doc = (await get(`/api/assets/${story}/markdown`)).json();
    expect(doc.text).toBe(STORY);
    expect(doc.refs['beach.png']).toMatchObject({ id: beach, kind: 'image' });
    expect(doc.refs['/f/beach.png']).toMatchObject({ id: beach });
    expect(doc.refs['./secret.png']).toMatchObject({ id: secret });
    expect(doc.refs['missing.png']).toBeNull();
    expect(doc.refs['clip.mp4']).toBeNull();
    expect(doc.refs).not.toHaveProperty('../../etc/passwd');
    expect(doc.refs).not.toHaveProperty('https://example.com/x.png');

    await post(`/api/assets/${secret}/hidden`, { hidden: true });
    const r = await get(`/api/assets/${story}/markdown`);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.json().refs['./secret.png']).toBeNull();
    const cookie = (await post('/api/unlock', { passphrase: PASS })).headers['set-cookie']!.toString().split(';')[0];
    doc = (await get(`/api/assets/${story}/markdown`, cookie)).json();
    expect(doc.refs['./secret.png']).toMatchObject({ id: secret, hidden: true });
  });

  it('can be hidden like any asset', async () => {
    const { story } = await setup();
    await post(`/api/assets/${story}/hidden`, { hidden: true });
    expect((await get('/api/assets')).json().items.map((x: { name: string }) => x.name)).not.toContain('story.md');
    for (const p of ['', '/markdown', '/thumb', '/file']) expect((await get(`/api/assets/${story}${p}`)).statusCode, p).toBe(404);
    const cookie = (await post('/api/unlock', { passphrase: PASS })).headers['set-cookie']!.toString().split(';')[0];
    expect((await get(`/api/assets/${story}/markdown`, cookie)).statusCode).toBe(200);
  });

  it('never claims, moves or deletes the caption sidecars of an image with the same stem', async () => {
    const { story, storyPng } = await setup();
    expect(env.db.caption(storyPng)).toMatchObject({ caption: 'a caption' });
    expect(env.db.caption(story)).toBeUndefined();
    expect((await post(`/api/assets/${story}/trash`)).statusCode).toBe(200);
    expect(fs.existsSync(path.join(env.lib('main'), 'f', 'story.txt'))).toBe(true);
    await env.trash.purge(story);
    expect(fs.existsSync(path.join(env.lib('main'), 'f', 'story.txt'))).toBe(true);
  });
});
