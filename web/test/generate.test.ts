import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server/app.js';
import { parseConfig } from '../src/server/config.js';
import { HttpError } from '../src/server/paths.js';
import type { ComfyClient, Graph, JobResult, Progress } from '../src/server/generate/comfy.js';
import { parseOutputUrl } from '../src/server/generate/comfy.js';
import { TagsFlow } from '../src/server/generate/flow.js';
import { VideoFlow, videoCanvas, videoFrames } from '../src/server/generate/video.js';
import type { Gpu, Tagger } from '../src/server/generate/tools.js';
import { makeEnv, makePng, ageAll, tmpDir, type Env } from './helpers.js';

const REPO_WORKFLOWS = path.resolve(import.meta.dirname, '..', '..', 'comfyui', 'workflows');

const PROMPTS = `
variationInstruction: VARY
traits:
  - [red hair]
  - [blue eyes, green eyes]
qualityTags: masterpiece
negativePrompt: worst quality
`;

function writePrompts(dir: string, text = PROMPTS) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'wai-illustrious-tags.yaml'), text);
}

/** In-memory ComfyUI: jobs finish when the test says so. */
class FakeComfy implements ComfyClient {
  online = true;
  submitted: { id: string; graph: Graph; pnginfo: Record<string, unknown> }[] = [];
  cancelled: string[] = [];
  private waiters = new Map<string, { onProgress: (p: Progress) => void; resolve: (r: JobResult) => void }>();
  private results = new Map<string, JobResult>();

  private check() {
    if (!this.online) throw new HttpError('ComfyUI is not running at http://fake. Start it and try again.', 503, { code: 'comfyui_down' });
  }
  async stats() {
    this.check();
    return { devices: [{ name: 'gpu', vramTotal: 16, vramFree: 8 }] };
  }
  async submit(graph: Graph, pnginfo: Record<string, unknown>) {
    this.check();
    const id = `p${this.submitted.length + 1}`;
    this.submitted.push({ id, graph, pnginfo });
    return id;
  }
  watch(promptId: string, onProgress: (p: Progress) => void, signal: AbortSignal) {
    const done = this.results.get(promptId);
    if (done) return Promise.resolve(done);
    return new Promise<JobResult>((resolve, reject) => {
      this.waiters.set(promptId, { onProgress, resolve });
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  }
  async cancel(promptId: string) {
    this.cancelled.push(promptId);
  }
  uploads: { file: string; name: string }[] = [];
  async upload(file: string, name: string) {
    this.check();
    this.uploads.push({ file, name });
  }
  progress(id: string, value: number, max: number) {
    this.waiters.get(id)?.onProgress({ node: '5', value, max });
  }
  finish(id: string, r: JobResult) {
    this.results.set(id, r);
    this.waiters.get(id)?.resolve(r);
    this.waiters.delete(id);
  }
}

/** Records what it is asked; `log` is shared with FakeGpu to check the order. */
class FakeTagger implements Tagger {
  requests: string[] = [];
  release: (() => void) | null = null;
  hold = false;
  constructor(private readonly log: string[]) {}
  async tags(description: string) {
    this.requests.push(description);
    this.log.push('tag start');
    if (this.hold) await new Promise<void>((r) => (this.release = r));
    this.log.push('tag end');
    return `tags ${this.requests.length}`;
  }
}

class FakeGpu implements Gpu {
  fail = false;
  constructor(private readonly log: string[]) {}
  async toComfy() {
    this.log.push('to comfy');
    if (this.fail) throw new HttpError('Could not hand the GPU to ComfyUI. Strata is busy', 503);
  }
}

const tick = () => new Promise((r) => setTimeout(r, 10));

describe('generate flow graphs', () => {
  const dir = tmpDir();
  writePrompts(path.join(dir, 'prompts'));
  const flow = new TagsFlow(parseConfig({ libraries: [{ id: 'a', path: dir }], generate: { promptsDir: path.join(dir, 'prompts') } }).generate);

  it('keeps prompt texts out of the workflow templates in the repo', () => {
    for (const f of fs.readdirSync(REPO_WORKFLOWS)) {
      const t = fs.readFileSync(path.join(REPO_WORKFLOWS, f), 'utf8');
      expect(t, f).not.toMatch(/masterpiece|worst quality|Danbooru tags for/);
    }
  });

  it('asks the tagger for the description, or a variation with suggested traits', () => {
    expect(flow.tagRequest('a girl', false)).toBe('a girl');
    expect(flow.tagRequest('a girl', true, () => 0.99)).toBe('a girl\n\nVARY\n\nSuggested traits: red hair, green eyes');
    expect(flow.tagsFrom('  1girl, solo \n')).toBe('masterpiece, 1girl, solo');
    expect(flow.tagsFrom('masterpiece, 1girl')).toBe('masterpiece, 1girl');
    expect(() => flow.tagsFrom(' ')).toThrow(/no tags/);
    expect(flow.info().defaultTags).toBe('masterpiece');
  });

  it('builds an image job with the literal tags and a restorable UI workflow', () => {
    const { graph, pnginfo } = flow.imageJob('a girl', 'masterpiece, 1girl, solo', 42);
    expect(Object.keys(graph).sort()).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    expect(graph['2'].inputs.text).toBe('masterpiece, 1girl, solo');
    expect(graph['3'].inputs.text).toBe('worst quality');
    expect(graph['5'].inputs.seed).toBe(42);
    expect(pnginfo.source_prompt).toBe('a girl');
    expect(pnginfo.tags).toBe('masterpiece, 1girl, solo');
    const nodes = (pnginfo.workflow as { nodes: { id: number; widgets_values: unknown[] }[] }).nodes;
    const w = (id: number) => nodes.find((n) => n.id === id)!.widgets_values[0];
    expect([w(2), w(3), w(5)]).toEqual(['masterpiece, 1girl, solo', 'worst quality', 42]);
    // Tags typed by hand, no description.
    expect(flow.imageJob('', '1girl', 1).pnginfo).not.toHaveProperty('source_prompt');
  });

  it('builds LoRA flows from the same prompts with the trigger tags in front', () => {
    const lora = { id: 'cat', title: 'Cat LoRA', lora: 'cat.safetensors', strength: 0.9, tags: 'mycat, cat', negative: 'realistic', dropTags: ['1girl'] };
    const cfg = parseConfig({ libraries: [{ id: 'a', path: dir }], generate: { promptsDir: path.join(dir, 'prompts'), loras: [lora] } }).generate;
    const [plain, f] = TagsFlow.all(cfg);
    expect(plain.id).toBe('wai-illustrious-tags');
    expect(f.info()).toMatchObject({ id: 'wai-illustrious-lora-cat', title: 'WAI-Illustrious · Cat LoRA', ready: true, defaultTags: 'masterpiece, mycat, cat' });
    expect(f.tagsFrom('1girl, cat, sitting, no humans')).toBe('masterpiece, mycat, cat, sitting, no humans');

    const { graph, pnginfo } = f.imageJob('a cat', 'masterpiece, mycat, cat, sitting', 7);
    expect(graph['2'].inputs.text).toBe('masterpiece, mycat, cat, sitting');
    expect(graph['15'].inputs).toMatchObject({ model: ['1', 0], lora_name: 'cat.safetensors', strength_model: 0.9 });
    expect(graph['5'].inputs.model).toEqual(['15', 0]);
    expect(graph['3'].inputs.text).toBe('worst quality, realistic');
    const nodes = (pnginfo.workflow as { nodes: { id: number; widgets_values: unknown[] }[] }).nodes;
    expect(nodes.find((n) => n.id === 15)!.widgets_values).toEqual(['cat.safetensors', 0.9]);
    expect(nodes.find((n) => n.id === 3)!.widgets_values[0]).toBe('worst quality, realistic');

    // A per-flow file overrides keys of the shared one.
    fs.writeFileSync(path.join(dir, 'prompts', 'wai-illustrious-lora-cat.yaml'), 'traits:\n  - [sleeping, jumping]\n');
    expect(f.tagRequest('a cat', true, () => 0)).toBe('a cat\n\nVARY\n\nSuggested traits: sleeping');
    expect(plain.tagRequest('a cat', true, () => 0)).toBe('a cat\n\nVARY\n\nSuggested traits: red hair, blue eyes');
    fs.rmSync(path.join(dir, 'prompts', 'wai-illustrious-lora-cat.yaml'));

    expect(() => parseConfig({ libraries: [{ id: 'a', path: dir }], generate: { loras: [{ id: 'X', lora: 'x' }] } })).toThrow(/lowercase/);
    expect(() => parseConfig({ libraries: [{ id: 'a', path: dir }], generate: { loras: [{ id: 'x' }] } })).toThrow(/lora is required/);
  });

  it('reports a missing or incomplete prompts file', () => {
    const other = tmpDir();
    const f = new TagsFlow(parseConfig({ libraries: [{ id: 'a', path: other }], generate: { promptsDir: other } }).generate);
    expect(f.info()).toMatchObject({ ready: false, problem: expect.stringMatching(/prompts file not found.*variationInstruction/) });
    writePrompts(other, 'variationInstruction: x\n');
    expect(f.info().problem).toMatch(/missing: traits, qualityTags, negativePrompt/);
    writePrompts(other, PROMPTS.replace('- [red hair]', '- []'));
    expect(f.info().problem).toMatch(/traits must be/);
  });

  it('builds a MiniMax H3 video job from the image, prompt and length', () => {
    // The template's 17k+5 frame grid at 24 fps, and H3's native canvas.
    expect([5, 8, 10, 12, 15].map(videoFrames)).toEqual([124, 192, 243, 294, 362]);
    expect(videoCanvas(1344, 768)).toEqual({ width: 1344, height: 768 });
    expect(videoCanvas(832, 1216)).toEqual({ width: 768, height: 1120 });
    expect(videoCanvas(1024, 1024)).toEqual({ width: 768, height: 768 });

    const v = new VideoFlow(parseConfig({ libraries: [{ id: 'a', path: dir }] }).generate);
    expect(v.info()).toMatchObject({ id: 'minimax-h3-i2v', kind: 'video', ready: true, seconds: [5, 8, 10, 12, 15], defaultSeconds: 5 });
    const { graph, pnginfo } = v.videoJob({ image: 'wg_abc.png', sourcePath: '/lib/cat.png', width: 832, height: 1216, seconds: 10 }, 'the cat waves', 9);
    expect(graph['6'].inputs).toMatchObject({ prompt: 'the cat waves', width: 768, height: 1120, length: 243, first_frame: ['16', 0] });
    expect(graph['16'].inputs.image).toBe('wg_abc.png');
    expect(graph['7'].inputs.noise_seed).toBe(9);
    // Default parameters: the 8-step turbo LoRA.
    expect(graph['2'].inputs.lora_name).toMatch(/turbo_8step/);
    expect(graph['10'].inputs.steps).toBe(8);
    expect(pnginfo.source_image).toBe('/lib/cat.png');
    const nodes = (pnginfo.workflow as { nodes: { id: number; widgets_values: unknown[] }[] }).nodes;
    expect(nodes.find((n) => n.id === 105)!.widgets_values.slice(0, 5)).toEqual(['the cat waves', 768, 1120, 10, 9]);
    expect(nodes.find((n) => n.id === 114)!.widgets_values[0]).toBe('wg_abc.png');
  });

  it('parses comfy-cli output URLs', () => {
    expect(parseOutputUrl('http://127.0.0.1:8188/view?filename=a%20b.png&subfolder=x%2Fy&type=output'))
      .toEqual({ filename: 'a b.png', subfolder: 'x/y', type: 'output' });
    expect(parseOutputUrl('nope')).toBeNull();
  });
});

describe('generate API', () => {
  let env: Env;
  let app: FastifyInstance;
  let comfy: FakeComfy;
  let tagger: FakeTagger;
  let gpu: FakeGpu;
  let log: string[];
  afterEach(async () => {
    await app?.close();
    await env?.close();
  });

  async function setup(prompts = true) {
    env = await makeEnv([{ id: 'comfyui' }, { id: 'comfyui-input' }, { id: 'photos' }], { generate: { promptsDir: '/nonexistent' } });
    const promptsDir = path.join(env.root, 'prompts');
    if (prompts) writePrompts(promptsDir);
    env.cfg.generate.promptsDir = promptsDir;
    comfy = new FakeComfy();
    log = [];
    tagger = new FakeTagger(log);
    gpu = new FakeGpu(log);
    app = await build();
  }

  const build = () => buildApp({ cfg: env.cfg, db: env.db, indexer: env.indexer, trash: env.trash, webRoot: null, generate: { comfy, tagger, gpu } });

  async function post(url: string, body: unknown = {}) {
    const csrf = (await app.inject({ url: '/api/session' })).json().csrf;
    return app.inject({ method: 'POST', url, payload: body as object, headers: { 'x-csrf-token': csrf } });
  }

  it('runs a LoRA flow with its own id', async () => {
    await setup();
    await app.close();
    env.cfg.generate.loras = [{ id: 'cat', title: 'Cat', lora: 'cat.safetensors', strength: 1, tags: 'mycat', negative: '', dropTags: [] }];
    app = await build();
    const flows = (await app.inject({ url: '/api/generate/flows' })).json().flows;
    expect(flows.map((f: { id: string }) => f.id)).toEqual(['wai-illustrious-tags', 'wai-illustrious-lora-cat', 'minimax-h3-i2v']);
    expect((await post('/api/generate/flows/wai-illustrious-lora-cat/tags', { prompt: 'a cat' })).json().tags).toBe('masterpiece, mycat, tags 1');
    const run = (await post('/api/generate/flows/wai-illustrious-lora-cat/runs', { prompt: 'a cat', variations: ['mycat, x'], batch: 1 })).json();
    expect(run.flow).toBe('wai-illustrious-lora-cat');
    expect(comfy.submitted[0].graph['15'].inputs.lora_name).toBe('cat.safetensors');
  });

  it('lists the flow and ComfyUI status', async () => {
    await setup();
    expect((await app.inject({ url: '/api/generate/flows' })).json().flows).toMatchObject([{ id: 'wai-illustrious-tags', ready: true }, { id: 'minimax-h3-i2v', kind: 'video' }]);
    expect((await app.inject({ url: '/api/generate/status' })).json()).toMatchObject({ online: true, devices: [{ name: 'gpu' }] });
    comfy.online = false;
    expect((await app.inject({ url: '/api/generate/status' })).json()).toMatchObject({ online: false, error: expect.stringMatching(/not running/) });
  });

  it('generates tags with the tagger', async () => {
    await setup();
    const r = await post('/api/generate/flows/wai-illustrious-tags/tags', { prompt: 'a girl', vary: true });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ tags: 'masterpiece, tags 1' });
    expect(tagger.requests[0]).toMatch(/^a girl\n\nVARY\n\nSuggested traits: /);

    expect((await post('/api/generate/flows/wai-illustrious-tags/tags', { prompt: ' ' })).statusCode).toBe(400);
    expect((await post('/api/generate/flows/nope/tags', { prompt: 'x' })).statusCode).toBe(404);
  });

  it('hands the GPU to ComfyUI before queueing, never in the middle of tagging', async () => {
    await setup();
    tagger.hold = true;
    const tagging = post('/api/generate/flows/wai-illustrious-tags/tags', { prompt: 'a girl' });
    await tick();
    const starting = post('/api/generate/flows/wai-illustrious-tags/runs', { prompt: 'a girl', variations: ['t'], batch: 1 });
    await tick();
    expect(log).toEqual(['tag start']);
    tagger.release!();
    expect((await tagging).statusCode).toBe(200);
    expect((await starting).statusCode).toBe(200);
    expect(log).toEqual(['tag start', 'tag end', 'to comfy']);
    expect(comfy.submitted).toHaveLength(1);

    gpu.fail = true;
    const r = await post('/api/generate/flows/wai-illustrious-tags/runs', { prompt: 'a girl', variations: ['t'], batch: 1 });
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toMatch(/hand the GPU/);
    expect(comfy.submitted).toHaveLength(1);
  });

  it('runs hand-typed tags without a description', async () => {
    await setup();
    const r = await post('/api/generate/flows/wai-illustrious-tags/runs', { prompt: '', variations: ['masterpiece, 1girl'], batch: 1 });
    expect(r.statusCode).toBe(200);
    expect(r.json().prompt).toBe('');
    expect(comfy.submitted[0].graph['2'].inputs.text).toBe('masterpiece, 1girl');
    expect(comfy.submitted[0].pnginfo).not.toHaveProperty('source_prompt');
    expect((await post('/api/generate/flows/wai-illustrious-tags/runs', { variations: ['x'], batch: 1 })).statusCode).toBe(200);
    expect((await post('/api/generate/flows/wai-illustrious-tags/runs', { prompt: 'a', variations: [' '], batch: 1 })).statusCode).toBe(400);
  });

  it('refuses to run without the prompts file', async () => {
    await setup(false);
    const r = await post('/api/generate/flows/wai-illustrious-tags/tags', { prompt: 'a girl' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/prompts file not found/);
  });

  it('queues variations x batch jobs, tracks progress and links outputs to assets', async () => {
    await setup();
    const bad = await post('/api/generate/flows/wai-illustrious-tags/runs', { prompt: 'a girl', variations: ['x'], batch: 0 });
    expect(bad.statusCode).toBe(400);

    const r = await post('/api/generate/flows/wai-illustrious-tags/runs', { prompt: 'a girl', variations: ['tags a', 'tags b'], batch: 2 });
    expect(r.statusCode).toBe(200);
    const run = r.json();
    expect(run.jobs.map((j: { variation: number; index: number; status: string }) => [j.variation, j.index, j.status]))
      .toEqual([[0, 0, 'queued'], [0, 1, 'queued'], [1, 0, 'queued'], [1, 1, 'queued']]);
    expect(comfy.submitted.map((s) => s.graph['2'].inputs.text)).toEqual(['tags a', 'tags a', 'tags b', 'tags b']);
    expect(new Set(comfy.submitted.map((s) => s.graph['5'].inputs.seed)).size).toBe(4);

    const get = async () => (await app.inject({ url: `/api/generate/runs/${run.id}` })).json();
    await tick();
    comfy.progress('p1', 7, 28);
    expect((await get()).jobs[0]).toMatchObject({ status: 'running', progress: 0.25 });

    // The first output is in the gallery already; the second is not indexed yet.
    await makePng(path.join(env.lib('comfyui'), 'WAI', 'img_00001_.png'));
    ageAll(env.root);
    await env.sync();
    comfy.finish('p1', { status: 'completed', outputs: [{ filename: 'img_00001_.png', subfolder: 'WAI', type: 'output' }], error: null });
    comfy.finish('p2', { status: 'completed', outputs: [{ filename: 'img_00002_.png', subfolder: 'WAI', type: 'output' }], error: null });
    comfy.finish('p3', { status: 'error', outputs: [], error: 'out of memory' });
    await tick();
    const mid = await get();
    expect(mid.status).toBe('running');
    expect(mid.jobs[0].outputs[0].asset).toMatchObject({ id: expect.any(Number) });
    expect(mid.jobs[1].outputs[0].asset).toBeNull();
    expect(mid.jobs[2]).toMatchObject({ status: 'error', error: 'out of memory' });

    comfy.finish('p4', { status: 'completed', outputs: [], error: null });
    await tick();
    expect((await get()).status).toBe('error');
    expect((await app.inject({ url: '/api/generate/runs' })).json().runs).toEqual([]);
  });

  it('cancels the unfinished jobs of a run', async () => {
    await setup();
    const run = (await post('/api/generate/flows/wai-illustrious-tags/runs', { prompt: 'a girl', variations: ['t'], batch: 3 })).json();
    await tick();
    comfy.finish('p1', { status: 'completed', outputs: [], error: null });
    await tick();
    comfy.progress('p2', 1, 28);
    const r = (await post(`/api/generate/runs/${run.id}/cancel`)).json();
    expect(r.status).toBe('cancelled');
    expect(r.jobs.map((j: { status: string }) => j.status)).toEqual(['completed', 'cancelled', 'cancelled']);
    // Pending jobs first, then the running one.
    expect(comfy.cancelled).toEqual(['p3', 'p2']);
    expect((await post('/api/generate/runs/nope/cancel')).statusCode).toBe(404);
  });

  it('lists only the runs still being worked on', async () => {
    await setup();
    const start = async () => (await post('/api/generate/flows/wai-illustrious-tags/runs', { prompt: 'a girl', variations: ['t'], batch: 1 })).json();
    const done = await start();
    await tick();
    comfy.finish('p1', { status: 'completed', outputs: [], error: null });
    await tick();
    const running = await start();
    expect((await app.inject({ url: '/api/generate/runs' })).json().runs.map((x: { id: string }) => x.id)).toEqual([running.id]);
    // An open page can still fetch the finished run's final state.
    expect((await app.inject({ url: `/api/generate/runs/${done.id}` })).json().status).toBe('completed');
  });

  it('fails the request when nothing could be queued', async () => {
    await setup();
    comfy.online = false;
    const r = await post('/api/generate/flows/wai-illustrious-tags/runs', { prompt: 'a girl', variations: ['t'], batch: 1 });
    expect(r.statusCode).toBe(503);
    expect((await app.inject({ url: '/api/generate/runs' })).json().runs).toEqual([]);
  });

  it('generates a video from a gallery image picked by path', async () => {
    await setup();
    const img = path.join(env.lib('comfyui'), 'kf', 'cat.png');
    await makePng(img, { w: 1344, h: 768 });
    await makePng(path.join(env.lib('comfyui'), 'clip.png'));
    ageAll(env.root);
    await env.sync();

    // The viewer's "Copy path" value, and the lookup behind "Paste".
    const asset = (await app.inject({ url: '/api/assets?library=comfyui&recursive=1' })).json().items.find((a: { name: string }) => a.name === 'cat.png');
    expect(asset.filePath).toBe(img);
    const found = await post('/api/generate/video/image', { path: `${img}` });
    expect(found.json().asset).toMatchObject({ id: asset.id, width: 1344, height: 768 });
    expect((await post('/api/generate/video/image', { path: 'kf/cat.png' })).statusCode).toBe(400);
    expect((await post('/api/generate/video/image', { path: '/etc/passwd' })).statusCode).toBe(404);
    expect((await post('/api/generate/video/image', { path: path.join(env.lib('comfyui'), 'kf', '..', '..', '..', 'data', 'gallery.db') })).statusCode).toBe(404);

    const url = '/api/generate/flows/minimax-h3-i2v/runs';
    expect((await post(url, { image: img, prompt: 'waves', seconds: 7 })).statusCode).toBe(400);
    expect((await post(url, { image: img, prompt: ' ', seconds: 5 })).statusCode).toBe(400);
    const r = await post(url, { image: img, prompt: 'the cat waves', seconds: 8, batch: 2 });
    expect(r.statusCode).toBe(200);
    const run = r.json();
    expect(run).toMatchObject({ flow: 'minimax-h3-i2v', prompt: 'the cat waves', video: { sourcePath: img, sourceAsset: asset.id, seconds: 8 } });
    expect(run.jobs).toHaveLength(2);
    // Already in ComfyUI's output folder: used in place, not uploaded.
    expect(comfy.uploads).toEqual([]);
    expect(log).toEqual(['to comfy']);
    expect(comfy.submitted.map((s) => s.graph['16'].inputs.image)).toEqual(['kf/cat.png [output]', 'kf/cat.png [output]']);
    expect(comfy.submitted[0].graph['6'].inputs).toMatchObject({ prompt: 'the cat waves', width: 1344, height: 768, length: 192 });
    expect(comfy.submitted[0].graph['7'].inputs.noise_seed).not.toBe(comfy.submitted[1].graph['7'].inputs.noise_seed);

    comfy.online = false;
    expect((await post(url, { image: img, prompt: 'x', seconds: 5 })).statusCode).toBe(503);
  });

  it('uploads a video input image only when it is outside ComfyUI\'s folders', async () => {
    await setup();
    const input = path.join(env.lib('comfyui-input'), 'refs', 'cat.png');
    const photo = path.join(env.lib('photos'), 'dog.png');
    await makePng(input);
    await makePng(photo);
    ageAll(env.root);
    await env.sync();

    const url = '/api/generate/flows/minimax-h3-i2v/runs';
    expect((await post(url, { image: input, prompt: 'waves', seconds: 5 })).statusCode).toBe(200);
    expect(comfy.uploads).toEqual([]);
    expect(comfy.submitted.at(-1)!.graph['16'].inputs.image).toBe('refs/cat.png');

    // Uploaded once under a content-derived name, after the GPU went to ComfyUI.
    expect((await post(url, { image: photo, prompt: 'barks', seconds: 5 })).statusCode).toBe(200);
    expect(comfy.uploads).toEqual([{ file: photo, name: expect.stringMatching(/^wg_[0-9a-f]{16}\.png$/) }]);
    expect(comfy.submitted.at(-1)!.graph['16'].inputs.image).toBe(comfy.uploads[0].name);
  });
});
