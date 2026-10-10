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
import { makeEnv, makePng, ageAll, tmpDir, type Env } from './helpers.js';

const REPO_WORKFLOWS = path.resolve(import.meta.dirname, '..', '..', 'comfyui', 'workflows');

const PROMPTS = `
systemPrompt: |-
  SYSTEM PROMPT
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
  textGraphs: Graph[] = [];
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
  async runText(graph: Graph) {
    this.check();
    this.textGraphs.push(graph);
    return { '14': [`tags ${this.textGraphs.length}`] };
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
  progress(id: string, value: number, max: number) {
    this.waiters.get(id)?.onProgress({ node: '5', value, max });
  }
  finish(id: string, r: JobResult) {
    this.results.set(id, r);
    this.waiters.get(id)?.resolve(r);
    this.waiters.delete(id);
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

  it('builds the tagging graph, plain and varied', () => {
    const g = flow.tagGraph('a girl', false);
    expect(Object.keys(g).sort()).toEqual(['10', '11', '14', '8', '9']);
    expect(g['8'].inputs.value).toBe('a girl');
    expect(g['9'].inputs.value).toBe('SYSTEM PROMPT');
    expect(g['11'].inputs.sampling_mode).toBe('off');
    expect(g['14']).toEqual({ class_type: 'PreviewAny', inputs: { source: ['11', 0] } });

    const v = flow.tagGraph('a girl', true, () => 0.99);
    expect(v['9'].inputs.value).toBe('SYSTEM PROMPT\n\nVARY');
    expect(v['8'].inputs.value).toBe('a girl\n\nSuggested traits: red hair, green eyes');
    expect(v['11'].inputs.sampling_mode).toBe('on');
    expect(typeof v['11'].inputs['sampling_mode.seed']).toBe('number');
    expect(flow.tagsFrom({ '14': ['  1girl, solo \n'] })).toBe('1girl, solo');
  });

  it('builds an image job with the literal tags and a restorable UI workflow', () => {
    const { graph, pnginfo } = flow.imageJob('a girl', '1girl, solo', 42);
    expect(Object.keys(graph).sort()).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    expect(graph['2'].inputs.text).toBe('masterpiece, 1girl, solo');
    expect(graph['3'].inputs.text).toBe('worst quality');
    expect(graph['5'].inputs.seed).toBe(42);
    expect(pnginfo.source_prompt).toBe('a girl');
    expect(pnginfo.tags).toBe('1girl, solo');
    const nodes = (pnginfo.workflow as { nodes: { id: number; widgets_values: unknown[] }[] }).nodes;
    const w = (id: number) => nodes.find((n) => n.id === id)!.widgets_values[0];
    expect([w(8), w(9), w(12), w(3), w(5)]).toEqual(['a girl', 'SYSTEM PROMPT', 'masterpiece', 'worst quality', 42]);
  });

  it('reports a missing or incomplete prompts file', () => {
    const other = tmpDir();
    const f = new TagsFlow(parseConfig({ libraries: [{ id: 'a', path: other }], generate: { promptsDir: other } }).generate);
    expect(f.info()).toMatchObject({ ready: false, problem: expect.stringMatching(/prompts file not found.*systemPrompt/) });
    writePrompts(other, 'systemPrompt: x\n');
    expect(f.info().problem).toMatch(/missing: variationInstruction, traits, qualityTags, negativePrompt/);
    writePrompts(other, PROMPTS.replace('- [red hair]', '- []'));
    expect(f.info().problem).toMatch(/traits must be/);
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
  afterEach(async () => {
    await app?.close();
    await env?.close();
  });

  async function setup(prompts = true) {
    env = await makeEnv([{ id: 'comfyui' }], { generate: { promptsDir: '/nonexistent' } });
    const promptsDir = path.join(env.root, 'prompts');
    if (prompts) writePrompts(promptsDir);
    env.cfg.generate.promptsDir = promptsDir;
    comfy = new FakeComfy();
    app = await buildApp({ cfg: env.cfg, db: env.db, indexer: env.indexer, trash: env.trash, webRoot: null, comfy });
  }

  async function post(url: string, body: unknown = {}) {
    const csrf = (await app.inject({ url: '/api/session' })).json().csrf;
    return app.inject({ method: 'POST', url, payload: body as object, headers: { 'x-csrf-token': csrf } });
  }

  it('lists the flow and ComfyUI status', async () => {
    await setup();
    expect((await app.inject({ url: '/api/generate/flows' })).json().flows).toMatchObject([{ id: 'wai-illustrious-tags', ready: true }]);
    expect((await app.inject({ url: '/api/generate/status' })).json()).toMatchObject({ online: true, devices: [{ name: 'gpu' }] });
    comfy.online = false;
    expect((await app.inject({ url: '/api/generate/status' })).json()).toMatchObject({ online: false, error: expect.stringMatching(/not running/) });
  });

  it('generates tags and reports ComfyUI being down', async () => {
    await setup();
    const r = await post('/api/generate/flows/wai-illustrious-tags/tags', { prompt: 'a girl', vary: true });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ tags: 'tags 1' });
    expect(comfy.textGraphs[0]['9'].inputs.value).toMatch(/VARY$/);

    expect((await post('/api/generate/flows/wai-illustrious-tags/tags', { prompt: ' ' })).statusCode).toBe(400);
    expect((await post('/api/generate/flows/nope/tags', { prompt: 'x' })).statusCode).toBe(404);
    comfy.online = false;
    const down = await post('/api/generate/flows/wai-illustrious-tags/tags', { prompt: 'a girl' });
    expect(down.statusCode).toBe(503);
    expect(down.json()).toMatchObject({ code: 'comfyui_down', error: expect.stringMatching(/not running/) });
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
    expect(comfy.submitted.map((s) => s.graph['2'].inputs.text)).toEqual(['masterpiece, tags a', 'masterpiece, tags a', 'masterpiece, tags b', 'masterpiece, tags b']);
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
    expect((await app.inject({ url: '/api/generate/runs' })).json().runs.map((x: { id: string }) => x.id)).toEqual([run.id]);
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

  it('fails the request when nothing could be queued', async () => {
    await setup();
    comfy.online = false;
    const r = await post('/api/generate/flows/wai-illustrious-tags/runs', { prompt: 'a girl', variations: ['t'], batch: 1 });
    expect(r.statusCode).toBe(503);
    expect((await app.inject({ url: '/api/generate/runs' })).json().runs).toEqual([]);
  });
});
