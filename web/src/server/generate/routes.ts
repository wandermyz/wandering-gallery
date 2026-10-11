import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../config.js';
import type { Db } from '../db.js';
import { HttpError } from '../paths.js';
import { CliComfyClient, type ComfyClient } from './comfy.js';
import { MAX_PROMPT, MAX_TAGS, TagsFlow } from './flow.js';
import { MAX_BATCH, MAX_VARIATIONS, Runs } from './runs.js';

function text(v: unknown, name: string, max: number): string {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(`${name} is required`, 400);
  if (v.length > max) throw new HttpError(`${name} is too long (max ${max} characters)`, 400);
  return v.trim();
}

/** `/api/generate/*`: the generation flows. */
export function registerGenerate(app: FastifyInstance, cfg: AppConfig, db: Db, comfy: ComfyClient = new CliComfyClient(cfg.generate.comfyui, cfg.generate.comfyCli)) {
  const flows = new Map(TagsFlow.all(cfg.generate).map((f) => [f.id, f]));
  const runs = new Runs(comfy, db, cfg.generate.outputLibrary, app.log);
  app.addHook('onClose', async () => runs.close());

  const getFlow = (id: string) => {
    const f = flows.get(id);
    if (!f) throw new HttpError('unknown flow', 404);
    return f;
  };

  app.get('/api/generate/flows', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { flows: [...flows.values()].map((f) => f.info()) };
  });

  app.get('/api/generate/status', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      return { url: cfg.generate.comfyui, online: true, error: null, ...(await comfy.stats()) };
    } catch (e) {
      return { url: cfg.generate.comfyui, online: false, error: (e as Error).message, devices: [] };
    }
  });

  app.post('/api/generate/flows/:flow/tags', async (req) => {
    const f = getFlow((req.params as { flow: string }).flow);
    const body = (req.body ?? {}) as { prompt?: unknown; vary?: unknown };
    const prompt = text(body.prompt, 'prompt', MAX_PROMPT);
    const graph = f.tagGraph(prompt, body.vary === true);
    return { tags: f.tagsFrom(await comfy.runText(graph)) };
  });

  app.post('/api/generate/flows/:flow/runs', async (req) => {
    const f = getFlow((req.params as { flow: string }).flow);
    const body = (req.body ?? {}) as { prompt?: unknown; variations?: unknown; batch?: unknown };
    const prompt = text(body.prompt, 'prompt', MAX_PROMPT);
    if (!Array.isArray(body.variations) || body.variations.length < 1 || body.variations.length > MAX_VARIATIONS) {
      throw new HttpError(`variations must be a list of 1-${MAX_VARIATIONS} tag strings`, 400);
    }
    const variations = body.variations.map((v, i) => text(v, `variation ${i + 1}`, MAX_TAGS));
    const batch = Number(body.batch);
    if (!Number.isInteger(batch) || batch < 1 || batch > MAX_BATCH) throw new HttpError(`batch must be an integer 1-${MAX_BATCH}`, 400);
    return runs.json(await runs.start(f, prompt, variations, batch));
  });

  app.get('/api/generate/runs', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { runs: runs.list().map((r) => runs.json(r)) };
  });

  app.get('/api/generate/runs/:id', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return runs.json(runs.get((req.params as { id: string }).id));
  });

  app.post('/api/generate/runs/:id/cancel', async (req) => {
    return runs.json(await runs.cancel((req.params as { id: string }).id));
  });
}
