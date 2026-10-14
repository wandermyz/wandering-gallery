import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { buildApp } from '../src/server/app.js';
import { fingerprint } from '../src/server/fileinfo.js';
import { audioPlayability, mediaType, ownsSidecars } from '../src/server/media.js';
import { extract } from '../src/server/metadata/extract.js';
import { ensureThumb } from '../src/server/thumbs.js';
import { ageAll, FFPROBE, fixture, hasFfmpeg, makeAudio, makeEnv, makePng, tmpDir, type Env } from './helpers.js';

let env: Env;
let app: FastifyInstance;
afterEach(async () => {
  await app?.close();
  await env?.close();
  env = undefined!;
  app = undefined!;
});

async function post(url: string, body: unknown = {}) {
  const csrf = (await app.inject({ url: '/api/session' })).json().csrf;
  return app.inject({ method: 'POST', url, payload: body as object, headers: { 'x-csrf-token': csrf, 'content-type': 'application/json' } });
}
const get = (url: string) => app.inject({ url });

describe('audio types', () => {
  it('recognises audio extensions and never gives them caption sidecars', () => {
    for (const ext of ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus']) {
      expect(mediaType(`a.${ext.toUpperCase()}`)?.kind, ext).toBe('audio');
      expect(ownsSidecars(`a.${ext}`), ext).toBe(false);
    }
    expect(mediaType('a.flac')?.mime).toBe('audio/flac');
  });

  it('knows which codecs browsers play', () => {
    expect(audioPlayability('mp3')).toBe('yes');
    expect(audioPlayability('pcm_s16le')).toBe('yes');
    expect(audioPlayability('alac')).toBe('partial');
    expect(audioPlayability('wmav2')).toBe('no');
    expect(audioPlayability(null)).toBe('unknown');
  });
});

describe.skipIf(!hasFfmpeg)('audio assets', () => {
  it('reads duration, codec and ComfyUI tags (SaveAudio writes them as Vorbis comments)', async () => {
    const dir = tmpDir();
    const flac = path.join(dir, 'a.flac');
    makeAudio(flac, { seconds: 2, metadata: { prompt: fixture('sdxl-basic.prompt.json').replace(/\s+/g, ' '), workflow: '{"nodes":[]}' } });
    const x = await extract(flac, 'audio', { ffprobe: FFPROBE });
    expect(x).toMatchObject({ audioCodec: 'flac', videoCodec: null, width: null, height: null, workflowJson: '{"nodes":[]}' });
    expect(x.duration).toBeCloseTo(2, 0);
    expect(x.summary?.params.seed).toBe(123456789);

    const opus = path.join(dir, 'a.opus');
    makeAudio(opus, { metadata: { workflow: '{"nodes":[1]}' } });
    expect(await extract(opus, 'audio', { ffprobe: FFPROBE })).toMatchObject({ audioCodec: 'opus', workflowJson: '{"nodes":[1]}' });
  });

  it('ignores cover art when reading stream info, and uses it as the thumbnail', async () => {
    env = await makeEnv();
    const file = path.join(env.lib('main'), 'song.mp3');
    makeAudio(file, { cover: true });
    expect(await extract(file, 'audio', { ffprobe: FFPROBE })).toMatchObject({ audioCodec: 'mp3', videoCodec: null, width: null });
    const out = await ensureThumb(file, 'audio', await fingerprint(file), env.indexer.thumbOptions());
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(info.height);
    expect(data[0]).toBeGreaterThan(200); // red cover
  });

  it('get a waveform thumbnail without cover art', async () => {
    env = await makeEnv();
    const file = path.join(env.lib('main'), 'tone.wav');
    makeAudio(file, { seconds: 0.3 });
    const out = await ensureThumb(file, 'audio', await fingerprint(file), env.indexer.thumbOptions());
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(env.indexer.thumbOptions().size);
  });

  it('are listed, filtered, counted and streamed', async () => {
    env = await makeEnv();
    app = await buildApp({ cfg: env.cfg, db: env.db, indexer: env.indexer, trash: env.trash, webRoot: null });
    const dir = env.lib('main');
    makeAudio(path.join(dir, 'ComfyUI_00001_.flac'), { seconds: 2 });
    // An image with the same stem keeps its caption sidecar.
    await makePng(path.join(dir, 'ComfyUI_00001_.png'));
    fs.writeFileSync(path.join(dir, 'ComfyUI_00001_.txt'), 'a caption');
    ageAll(env.root);
    await env.sync();

    const items = (await get('/api/assets?kind=audio')).json().items;
    expect(items).toHaveLength(1);
    const a = items[0];
    expect(a).toMatchObject({ kind: 'audio', mime: 'audio/flac', playable: 'yes', audioCodec: 'flac', caption: null, indexState: 'done' });
    expect(a.duration).toBeCloseTo(2, 0);
    expect((await get('/api/libraries')).json().libraries[0]).toMatchObject({ audio: 1, images: 1 });
    expect((await get(`/api/assets/${a.id}/thumb`)).statusCode).toBe(200);
    expect((await get(`/api/assets/${a.id}/caption`)).statusCode).toBe(400);

    const size = fs.statSync(path.join(dir, 'ComfyUI_00001_.flac')).size;
    const r = await app.inject({ url: `/api/assets/${a.id}/file`, headers: { range: `bytes=${size - 100}-` } });
    expect(r.statusCode).toBe(206);
    expect(r.headers['content-type']).toBe('audio/flac');

    expect((await post(`/api/assets/${a.id}/trash`)).statusCode).toBe(200);
    expect(fs.existsSync(path.join(dir, 'ComfyUI_00001_.txt'))).toBe(true);
    const png = env.db.get<{ id: number }>("SELECT id FROM assets WHERE name = 'ComfyUI_00001_.png'")!;
    expect(env.db.caption(png.id)).toMatchObject({ caption: 'a caption' });
  });
});
