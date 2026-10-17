// A populated backend for developing and testing the iOS app (ios/): builds a library of
// generated media under .tmp/ios-dev on the first run, then starts the real server with the
// browser tests' stand-ins for ComfyUI, comfy-cli, danbooru-tagger, gpu-workload and
// nvidia-smi, and seeds favorites, ratings, tags, hidden items and trash through the API.
//
//   npm run build && npm run dev:ios            # keeps the data between runs
//   npm run dev:ios -- --reset                  # starts over
//
// Listens on 127.0.0.1:2399 only. The simulator uses http://localhost:2399; a phone or iPad
// goes through Tailscale Serve over HTTPS (set up once, it persists):
//   tailscale serve --bg --https=23399 http://127.0.0.1:2399
// then https://<machine>.<tailnet>.ts.net:23399. Passphrase for hidden items:
// "ios dev passphrase". Everything in it is generated test data.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FFMPEG, FFPROBE, fixture, hasFfmpeg, makeAudio, makeJpeg, makePng, makeVideo } from '../test/helpers.js';
import { hashPassphrase } from '../src/server/unlock.js';

const PORT = Number(process.env.IOS_DEV_PORT ?? 2399);
/** Tailscale Serve's HTTPS port in front of PORT. */
const HTTPS_PORT = Number(process.env.IOS_DEV_HTTPS_PORT ?? 23399);
const COMFY_PORT = PORT + 1;
const PASSPHRASE = 'ios dev passphrase';
const web = path.resolve(import.meta.dirname, '..');
const root = path.join(web, '.tmp/ios-dev');
const reset = process.argv.includes('--reset');

const DAY = 86_400_000;
const rand = (() => {
  let s = 42;
  return () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
})();
const pick = <T>(a: T[]) => a[Math.floor(rand() * a.length)];

const SUBJECTS = [
  'a lighthouse on a cliff at dusk', 'a fox in a snowy forest', 'a cyberpunk street market at night',
  'a girl with an umbrella in the rain', 'a cat sleeping on a windowsill', 'a mountain lake at sunrise',
  'a dragon over a medieval castle', 'a cozy library with tall shelves', 'a koi pond in autumn',
  'an astronaut on a red desert', 'a bakery storefront in Paris', 'a samurai under cherry blossoms',
];
const STYLES = ['highly detailed', 'watercolor', 'anime style', 'cinematic lighting', 'oil painting', 'masterpiece, best quality'];
const SIZES: [number, number][] = [[832, 1216], [1216, 832], [1024, 1024], [768, 1344], [1344, 768]];

/** A ComfyUI prompt graph like sdxl-basic, with its own text, seed and size. */
function promptGraph(i: number, w: number, h: number, lora: boolean): string {
  const g = JSON.parse(fixture(lora ? 'controlnet-lora.prompt.json' : 'sdxl-basic.prompt.json'));
  for (const n of Object.values<{ class_type: string; inputs: Record<string, unknown> }>(g)) {
    if (n.class_type === 'CLIPTextEncode' && typeof n.inputs.text === 'string' && !/blurry|lowres|worst/.test(n.inputs.text)) {
      n.inputs.text = `${pick(SUBJECTS)}, ${pick(STYLES)}, ${pick(STYLES)}`;
    }
    if ('seed' in n.inputs) n.inputs.seed = 100000 + i * 7919;
    if ('steps' in n.inputs) n.inputs.steps = pick([20, 25, 28, 30]);
    if ('cfg' in n.inputs) n.inputs.cfg = pick([4.5, 5.5, 7]);
    if (n.class_type === 'EmptyLatentImage') Object.assign(n.inputs, { width: w, height: h });
  }
  return JSON.stringify(g);
}

function setTime(file: string, ms: number) {
  const t = new Date(ms);
  fs.utimesSync(file, t, t);
}

async function buildLibrary() {
  fs.rmSync(root, { recursive: true, force: true });
  const out = path.join(root, 'comfy-out');
  const refs = path.join(root, 'refs');
  const vault = path.join(root, 'vault');
  const now = Date.now();
  console.log('ios-dev: generating media…');

  // ~300 ComfyUI outputs over the last 30 days, a few per day, in date folders some days.
  for (let i = 1; i <= 300; i++) {
    const [w, h] = pick(SIZES);
    const ageMs = Math.floor((i / 300) * 30 * DAY + rand() * DAY * 0.5);
    const day = new Date(now - ageMs).toISOString().slice(0, 10);
    const sub = i % 3 === 0 ? day : '';
    const file = path.join(out, sub, `ComfyUI_${String(i).padStart(5, '0')}_.png`);
    // Thumbnails are generated from these, so a quarter of the real size is plenty.
    await makePng(file, {
      w: Math.round(w / 4), h: Math.round(h / 4), color: `hsl(${(i * 37) % 360}, ${45 + (i % 4) * 10}%, ${35 + (i % 5) * 6}%)`,
      text: { prompt: promptGraph(i, w, h, i % 7 === 0), ...(i % 11 === 0 ? { workflow: fixture('sdxl-basic.workflow.json') } : {}) },
    });
    setTime(file, now - ageMs);
  }
  if (hasFfmpeg) {
    for (let i = 1; i <= 8; i++) {
      const file = path.join(out, 'video', `wan_${String(i).padStart(5, '0')}_.mp4`);
      makeVideo(file, { seconds: 2 + (i % 4), metadata: { prompt: fixture('wan-video.prompt.json').replace(/\s+/g, ' ') } });
      setTime(file, now - i * 2.5 * DAY);
    }
    // A tall clip (768x1344 at half size), like a vertical image-to-video output.
    const tall = path.join(out, 'video', 'tall_00001_.mp4');
    execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=384x672:rate=24:duration=6',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', tall]);
    setTime(tall, now - 0.5 * DAY);
    for (let i = 1; i <= 4; i++) {
      const file = path.join(out, 'audio', `ace_${String(i).padStart(5, '0')}_.${i % 2 ? 'flac' : 'mp3'}`);
      makeAudio(file, { seconds: 5 + i * 2, cover: i % 2 === 0, metadata: { title: `Test tune ${i}` } });
      setTime(file, now - i * 4 * DAY);
    }
  }

  // A Markdown story with embedded media and Mermaid diagrams.
  const story = path.join(out, 'stories');
  await makePng(path.join(story, 'harbor.png'), { w: 300, h: 450, color: '#2d5a8a' });
  await makePng(path.join(story, 'storm.png'), { w: 450, h: 300, color: '#4a3a6a' });
  await makePng(path.join(story, 'secret.png'), { w: 200, h: 200, color: '#c04c6a' });
  if (hasFfmpeg) makeVideo(path.join(story, 'waves.mp4'), { seconds: 2 });
  fs.writeFileSync(path.join(story, 'the-harbor.md'), [
    '# The Harbor', '', '*A short story with pictures.*', '',
    'The boats came in at dawn, one by one, their lanterns still lit.', '', '![The harbor at dawn](harbor.png)', '',
    ...Array.from({ length: 6 }, (_, i) => `Paragraph ${i + 1}. Gulls wheeled over the water while the nets were hauled in, heavy with the night's catch.\n`),
    '## The storm', '', '![](storm.png)', '', '<video src="waves.mp4"></video>', '',
    '| Boat | Catch |', '| --- | --- |', '| Marie | 40 kg |', '| Sólveig | 12 kg |', '',
    '```mermaid', 'flowchart LR', '  Dawn --> Harbor --> Storm --> Dusk', '  Harbor --> Market', '```', '',
    'A secret picture: ![](secret.png)', '', 'See [the harbor](harbor.png) again. **The end.**', '',
  ].join('\n'));
  fs.writeFileSync(path.join(story, 'notes.md'), '# Notes\n\n- [ ] Re-render the storm\n- [x] Pick a palette\n\n```mermaid\nsequenceDiagram\n  Writer->>ComfyUI: prompt\n  ComfyUI-->>Writer: image\n```\n');
  for (const f of fs.readdirSync(story)) setTime(path.join(story, f), now - 1.5 * DAY);

  // A read-only reference library, with caption sidecars in every status.
  const statuses = ['generated', 'edited', 'approved', 'needs_regen', 'generated'] as const;
  for (let i = 1; i <= 24; i++) {
    const folder = path.join(refs, i <= 12 ? 'portraits' : 'landscapes');
    const stem = `ref_${String(i).padStart(3, '0')}`;
    await makeJpeg(path.join(folder, `${stem}.jpg`), `hsl(${i * 23}, 40%, 50%)`);
    if (i <= 10) {
      const caption = `${i <= 12 ? 'portrait, person' : 'landscape'}, style ${i}, soft light`;
      fs.writeFileSync(path.join(folder, `${stem}.txt`), caption);
      fs.writeFileSync(path.join(folder, `${stem}.caption.json`), JSON.stringify({
        schema: 'wandering-lora/caption@1', image: `${stem}.jpg`, status: statuses[i % statuses.length],
        caption_sha256: crypto.createHash('sha256').update(caption).digest('hex'), caption,
        description: `Reference image ${i}.`, classification: { view: i % 2 ? 'front' : 'side', face_visible: i % 2 === 1 },
        raw: { output: caption }, generation: { model: 'Qwen/Qwen3.5-4B', created_at: '2026-10-10T05:30:00Z' },
        candidate: i % 3 === 0 ? { caption: `${caption}, detailed` } : null, previous: null, updated_at: '2026-10-10T05:30:00Z',
      }, null, 2));
    }
    for (const f of fs.readdirSync(folder)) if (f.startsWith(stem)) setTime(path.join(folder, f), now - (40 + i) * DAY);
  }

  // A hidden library (only shown once unlocked).
  for (let i = 1; i <= 6; i++) {
    const file = path.join(vault, `private_${i}.png`);
    await makePng(file, { w: 200, h: 300, color: `hsl(${300 + i * 8}, 50%, 40%)` });
    setTime(file, now - i * 3 * DAY);
  }

  fs.mkdirSync(path.join(root, 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'prompts', 'wai-illustrious-tags.yaml'), [
    'variationInstruction: Make a distinct character.',
    'traits:', '  - [red hair, blue hair, silver hair]', '  - [smile, serious, surprised]',
    'qualityTags: masterpiece, best quality, amazing quality',
    'negativePrompt: worst quality, low quality, bad anatomy', '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'prompts', 'minimax-h3-i2v.yaml'), 'negativePrompt: blurry, static\n');
}

async function writeConfig() {
  const ts = tailnetName();
  fs.writeFileSync(path.join(root, 'config.yaml'), `
server:
  host: 127.0.0.1
  port: ${PORT}
  allowedHosts: [${[os.hostname().toLowerCase(), ...(ts ? [ts] : [])].map((h) => JSON.stringify(h)).join(', ')}]
dataDir: ./data
cacheDir: ./cache
scan:
  stableSeconds: 1
generate:
  comfyui: http://127.0.0.1:${COMFY_PORT}
  comfyCli: ${path.join(web, 'e2e/fake-comfy-cli.mjs')}
  tagger: ${path.join(web, 'e2e/fake-danbooru-tagger.mjs')}
  gpuWorkload: ${path.join(web, 'e2e/fake-gpu-workload.mjs')}
  outputLibrary: comfyui
  promptsDir: ./prompts
  loras:
    - id: mycat
      title: My cat LoRA
      lora: mycat.safetensors
      tags: mycat, cat
      negative: realistic
hidden:
  passphraseHash: ${await hashPassphrase(PASSPHRASE)}
  unlockMinutes: 15
tools:
  ffmpeg: ${FFMPEG}
  ffprobe: ${FFPROBE}
  nvidiaSmi: ${path.join(web, 'e2e/fake-nvidia-smi.mjs')}
libraries:
  - id: comfyui
    name: ComfyUI Outputs
    path: ./comfy-out
    writable: true
  - id: refs
    name: References
    path: ./refs
    writable: false
    showInAll: false
  - id: vault
    name: Vault
    path: ./vault
    writable: true
    hidden: true
`);
}

function tailnetName(): string | null {
  for (const bin of ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']) {
    try {
      const out = execFileSync(bin, ['status', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const name = JSON.parse(out).Self?.DNSName as string | undefined;
      if (name) return name.replace(/\.$/, '').toLowerCase();
    } catch {
      /* not installed */
    }
  }
  return null;
}

// ---- Seeding through the API ------------------------------------------------------------

const base = `http://127.0.0.1:${PORT}`;
let csrf = '';
let cookie = '';
async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(base + url, {
    method,
    headers: { ...(method !== 'GET' ? { 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined,
  });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  if (!r.ok) throw new Error(`${method} ${url}: ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}

interface A { id: number; name: string; kind: string; size: number; mtimeMs: number; folder: string }

async function seed() {
  csrf = (await call<{ csrf: string }>('GET', '/api/session')).csrf;
  // Wait for the first scan to list everything.
  for (let i = 0; i < 120; i++) {
    const s = await call<{ scanning: boolean; pending: number }>('GET', '/api/status');
    if (!s.scanning && s.pending === 0) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const page = await call<{ items: A[] }>('GET', '/api/assets?library=comfyui&limit=500');
  const imgs = page.items.filter((a) => a.kind === 'image' && a.folder !== 'stories');
  const tags = ['portfolio', 'landscape', 'character', 'to-upscale', 'wip'];
  for (const [i, a] of imgs.entries()) {
    if (i % 5 === 0) await call('POST', `/api/assets/${a.id}/favorite`, { favorite: true });
    if (i % 3 === 0) await call('POST', `/api/assets/${a.id}/rating`, { rating: 1 + (i % 5) });
    if (i % 4 === 0) await call('POST', `/api/assets/${a.id}/tags`, { add: [tags[i % tags.length], ...(i % 8 === 0 ? [tags[(i + 2) % tags.length]] : [])] });
  }
  await call('POST', `/api/assets/${imgs[3].id}/tags`, { add: ['private'] });
  const tagList = await call<{ tags: { id: number; name: string }[] }>('GET', '/api/tags');
  const priv = tagList.tags.find((t) => t.name === 'private');
  if (priv) await call('POST', `/api/tags/${priv.id}/hidden`, { hidden: true });
  for (const a of imgs.slice(10, 13)) await call('POST', `/api/assets/${a.id}/hidden`, { hidden: true });
  const secret = page.items.find((a) => a.name === 'secret.png');
  if (secret) await call('POST', `/api/assets/${secret.id}/hidden`, { hidden: true });
  for (const a of imgs.slice(20, 24)) await call('POST', `/api/assets/${a.id}/trash`, { size: a.size, mtimeMs: a.mtimeMs });
  console.log(`ios-dev: seeded ${imgs.length} images (favorites, ratings, tags, 4 hidden, 4 in the trash)`);
}

// ---- Main -----------------------------------------------------------------------------

const fresh = reset || !fs.existsSync(path.join(root, 'config.yaml'));
if (fresh) await buildLibrary();
// Rewritten every start, so config changes here apply to existing data too.
await writeConfig();
const server = path.join(web, 'dist/server/main.js');
if (!fs.existsSync(server)) {
  console.error('ios-dev: run `npm run build` first');
  process.exit(1);
}
const procs: ChildProcess[] = [
  spawn(process.execPath, [path.join(web, 'e2e/fake-comfy.mjs'), String(COMFY_PORT), path.join(root, 'comfy-out')], {
    stdio: 'inherit', env: { ...process.env, FAKE_COMFY_STEP_MS: process.env.FAKE_COMFY_STEP_MS ?? '1500', FFMPEG },
  }),
  spawn(process.execPath, [server, '--config', path.join(root, 'config.yaml')], {
    cwd: root, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, WANDERING_GALLERY_WEB: path.join(web, 'dist/web') },
  }),
];
const stop = () => {
  for (const p of procs) p.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => {
  console.error(`ios-dev: a process exited (${code}); stopping`);
  stop();
});

for (let i = 0; ; i++) {
  try {
    await fetch(`${base}/api/libraries`);
    break;
  } catch {
    if (i > 60) throw new Error('server did not start');
    await new Promise((r) => setTimeout(r, 500));
  }
}
if (fresh) await seed();
const ts = tailnetName();
console.log(`ios-dev: ready on http://localhost:${PORT}${ts ? ` and, through Tailscale Serve, https://${ts}:${HTTPS_PORT}` : ''} (passphrase: "${PASSPHRASE}")`);
