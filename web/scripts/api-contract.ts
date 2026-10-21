// The API contract between the server and the iOS app (ios/). Starts a fresh seeded backend
// (scripts/ios-dev-backend.ts, its own folder and port), calls every endpoint the app uses,
// and compares each response's structure (keys and JSON types, recursively) with the iOS
// test fixtures in ios/WanderingGalleryTests/Fixtures, which the iOS unit tests decode.
//
//   npm run test:contract               # fails if a response's structure changed
//   npm run test:contract -- --update   # rewrites the fixtures (then make the iOS app decode them)
//
// Values that differ between runs (times, paths, ids, versions) are normalized in the
// fixtures, so an update only shows real changes. Needs ffmpeg, like the dev backend.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const web = path.resolve(import.meta.dirname, '..');
const fixtures = path.resolve(web, '../ios/WanderingGalleryTests/Fixtures');
const PORT = 2410;
const base = `http://127.0.0.1:${PORT}`;
const update = process.argv.includes('--update');

// ---- Backend ------------------------------------------------------------------------------

const backend = spawn(process.execPath, ['--import', 'tsx', path.join(web, 'scripts/ios-dev-backend.ts'), '--reset'], {
  cwd: web,
  env: { ...process.env, IOS_DEV_ROOT: '.tmp/contract', IOS_DEV_PORT: String(PORT), IOS_DEV_IMAGES: '40', FAKE_COMFY_STEP_MS: '100' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
const stop = () => backend.kill();
process.on('exit', stop);

await new Promise<void>((resolve, reject) => {
  let out = '';
  backend.stdout!.on('data', (d: Buffer) => {
    out += d.toString();
    if (out.includes('ios-dev: ready')) resolve();
  });
  backend.on('exit', (code) => reject(new Error(`the dev backend exited (${code}) before it was ready:\n${out}`)));
});

// ---- Calls --------------------------------------------------------------------------------

let csrf = '';
async function call(method: string, url: string, body?: unknown): Promise<unknown> {
  const r = await fetch(base + url, {
    method,
    headers: method === 'GET' ? {} : { 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  if (!r.ok) throw new Error(`${method} ${url}: ${r.status} ${await r.text()}`);
  return r.json();
}
const get = (url: string) => call('GET', url);

interface A { id: number; name: string; kind: string; folder: string; hasMeta: boolean; filePath: string | null }
type Run = { id: string; status: string };

const captured: Record<string, unknown> = {};
const session = (await get('/api/session')) as { csrf: string };
csrf = session.csrf;
captured.session = session;
captured.libraries = await get('/api/libraries');
captured.status = await get('/api/status');
const page = (await get('/api/assets?library=comfyui&limit=5')) as { items: A[] };
captured.assets = page;
const all = ((await get('/api/assets?limit=500')) as { items: A[] }).items;
const image = all.find((a) => a.kind === 'image' && a.hasMeta)!;
captured.asset = await get(`/api/assets/${image.id}`);
captured.metadata = await get(`/api/assets/${image.id}/metadata`);
captured.folders = await get('/api/folders?library=comfyui&folder=');
captured.tags = await get('/api/tags');
captured.trash = await get('/api/trash');
const captioned = ((await get('/api/assets?library=refs&caption=any&limit=1')) as { items: A[] }).items[0];
captured.caption = await get(`/api/assets/${captioned.id}/caption`);
const doc = all.find((a) => a.name === 'the-harbor.md')!;
captured.markdown = await get(`/api/assets/${doc.id}/markdown`);
// Multi-select: a missing id makes each response list a failure too.
const comfyImages = page.items.filter((a) => a.kind === 'image');
const missing = 999_999_999;
captured['batch-hidden'] = await call('POST', '/api/batch/hidden', { ids: [comfyImages[0].id, missing], hidden: false });
const victim = (await get(`/api/assets/${comfyImages[0].id}`)) as A & { size: number; mtimeMs: number };
captured['batch-trash'] = await call('POST', '/api/batch/trash', { items: [{ id: victim.id, size: victim.size, mtimeMs: victim.mtimeMs }, { id: missing }] });
captured['batch-restore'] = await call('POST', '/api/batch/restore', { ids: [victim.id, missing] });

captured.flows = await get('/api/generate/flows');
captured['comfy-status'] = await get('/api/generate/status');
captured['generate-tags'] = await call('POST', '/api/generate/flows/wai-illustrious-tags/tags', { prompt: 'a cat on a roof', vary: false });
captured['video-image'] = await call('POST', '/api/generate/video/image', { path: image.filePath });
const run = (await call('POST', '/api/generate/flows/wai-illustrious-tags/runs', { prompt: 'a cat', variations: ['masterpiece, 1girl'], batch: 2 })) as Run;
captured.runs = await get('/api/generate/runs');
for (let i = 0; ; i++) {
  const r = (await get(`/api/generate/runs/${run.id}`)) as Run;
  if (r.status !== 'running') {
    captured.run = r;
    break;
  }
  if (i > 300) throw new Error('the run did not finish');
  await new Promise((res) => setTimeout(res, 200));
}
captured.dashboard = await get('/api/dashboard');
stop();

// ---- Normalizing and comparing ------------------------------------------------------------

const root = path.resolve(web, '.tmp/contract');
const FIXED_MS = 1_792_000_000_000;

/** Stable values for what differs between runs, keeping each value's JSON type. */
function normalize(v: unknown, key = ''): unknown {
  if (Array.isArray(v)) return v.map((x) => normalize(x));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalize(x, k)]));
  if (typeof v === 'number' && /(Ms|_time)$/.test(key)) return FIXED_MS;
  if (typeof v === 'number' && ['util', 'seed', 'progress'].includes(key)) return 0;
  if (typeof v === 'string') {
    if (key === 'csrf') return 'csrf-token';
    if (key === 'v') return 'v';
    if (key === 'next') return 'cursor';
    if (key === 'id' && /^[0-9a-f]{8,}$/.test(v)) return 'run-id';
    return v.split(root).join('/srv/gallery');
  }
  return v;
}

type Shape = string | { [k: string]: Shape } | { '[]': Shape[] };

/** Keys and JSON types, recursively; an array's items merged into one list of shapes. */
function shape(v: unknown): Shape {
  if (v === null) return 'null';
  if (Array.isArray(v)) {
    const seen = new Map<string, Shape>();
    for (const x of v) {
      const s = shape(x);
      seen.set(JSON.stringify(s), s);
    }
    return { '[]': [...seen.values()] };
  }
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, shape(x)]));
  return typeof v;
}

/** Differences between two shapes. `null` is compatible with any type (optional values). */
function diff(a: Shape, b: Shape, at: string, out: string[]) {
  if (a === 'null' || b === 'null') return;
  if (typeof a === 'string' || typeof b === 'string') {
    if (a !== b && !(typeof a === 'string' && typeof b === 'string')) out.push(`${at}: ${describe(a)} → ${describe(b)}`);
    else if (a !== b) out.push(`${at}: ${a} → ${b}`);
    return;
  }
  if ('[]' in a || '[]' in b) {
    if (!('[]' in a && '[]' in b)) return void out.push(`${at}: ${describe(a)} → ${describe(b)}`);
    // Compare items as one shape per side: the union of all the items' shapes.
    const ia = (a as { '[]': Shape[] })['[]'].reduce(union, 'null'), ib = (b as { '[]': Shape[] })['[]'].reduce(union, 'null');
    // Empty arrays say nothing about their items.
    if (ia !== 'null' && ib !== 'null') diff(ia, ib, `${at}[]`, out);
    return;
  }
  const oa = a as Record<string, Shape>, ob = b as Record<string, Shape>;
  for (const k of Object.keys(oa)) if (!(k in ob)) out.push(`${at}.${k}: removed`);
  for (const k of Object.keys(ob)) if (!(k in oa)) out.push(`${at}.${k}: added (${describe(ob[k])})`);
  for (const k of Object.keys(oa)) if (k in ob) diff(oa[k], ob[k], `${at}.${k}`, out);
}

const isObject = (s: Shape): s is Record<string, Shape> => typeof s === 'object' && !('[]' in s);

/** One shape covering both: object keys merged; `null` gives way to the other type. */
function union(a: Shape, b: Shape): Shape {
  if (a === 'null') return b;
  if (b === 'null') return a;
  if (isObject(a) && isObject(b)) {
    const o: Record<string, Shape> = { ...a };
    for (const [k, v] of Object.entries(b)) o[k] = k in o ? union(o[k], v) : v;
    return o;
  }
  return a;
}

const describe = (s: Shape) => (typeof s === 'string' ? s : '[]' in s ? 'array' : 'object');

// ---- Result -------------------------------------------------------------------------------

const problems: string[] = [];
for (const [name, value] of Object.entries(captured)) {
  const file = path.join(fixtures, `${name}.json`);
  const fresh = normalize(value);
  if (update) {
    fs.writeFileSync(file, JSON.stringify(fresh, null, 2) + '\n');
    continue;
  }
  if (!fs.existsSync(file)) {
    problems.push(`${name}.json: new endpoint response with no fixture`);
    continue;
  }
  const out: string[] = [];
  diff(shape(JSON.parse(fs.readFileSync(file, 'utf8'))), shape(fresh), name, out);
  problems.push(...out);
}
const stale = fs.readdirSync(fixtures).filter((f) => f.endsWith('.json') && !(f.replace(/\.json$/, '') in captured));
problems.push(...stale.map((f) => `${f}: fixture for a response that is no longer captured`));

if (update) {
  console.log(`api-contract: wrote ${Object.keys(captured).length} fixtures to ${path.relative(process.cwd(), fixtures)}`);
  if (stale.length) console.log(`api-contract: not captured any more (delete them?): ${stale.join(', ')}`);
  console.log('api-contract: now make the iOS app decode them (WanderingGalleryTests), or record iOS as pending in docs/parity.md.');
} else if (problems.length) {
  console.error('api-contract: the API changed shape since the iOS fixtures were captured:');
  for (const p of problems) console.error(`  - ${p}`);
  console.error('Run `npm run test:contract -- --update`, update the iOS models (ios/WanderingGallery/API/Models.swift)');
  console.error('so WanderingGalleryTests decode the new fixtures, or record the iOS work as pending in docs/parity.md.');
  process.exit(1);
} else {
  console.log(`api-contract: ${Object.keys(captured).length} responses match the iOS fixtures`);
}
process.exit(0);
