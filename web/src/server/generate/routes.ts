import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import type { AssetRow, Db } from '../db.js';
import { HttpError } from '../paths.js';
import { CliComfyClient, type ComfyClient } from './comfy.js';
import { MAX_PROMPT, MAX_TAGS, TagsFlow } from './flow.js';
import { MAX_BATCH, MAX_VARIATIONS, MAX_VIDEO_BATCH, Runs } from './runs.js';
import { CliGpu, CliTagger, type Gpu, type Tagger } from './tools.js';
import { MAX_VIDEO_PROMPT, VIDEO_SECONDS, VideoFlow } from './video.js';

function text(v: unknown, name: string, max: number, optional = false): string {
  if (typeof v !== 'string' || (!optional && !v.trim())) throw new HttpError(`${name} is required`, 400);
  if (v.length > max) throw new HttpError(`${name} is too long (max ${max} characters)`, 400);
  return v.trim();
}

/** ComfyUI, the tagger and the GPU hand-over; tests pass fakes. */
export interface GenerateDeps {
  comfy?: ComfyClient;
  tagger?: Tagger;
  gpu?: Gpu;
}

/** A gallery image by absolute path, confined to the libraries (see app.ts). */
export type ImageAt = (req: FastifyRequest, file: string) => Promise<{ row: AssetRow; asset: unknown; file: string }>;

/** `/api/generate/*`: the generation flows. */
export function registerGenerate(app: FastifyInstance, cfg: AppConfig, db: Db, imageAt: ImageAt, deps: GenerateDeps = {}) {
  const g = cfg.generate;
  const comfy = deps.comfy ?? new CliComfyClient(g.comfyui, g.comfyCli);
  const tagger = deps.tagger ?? new CliTagger(g.tagger);
  const gpu = deps.gpu ?? (g.gpuWorkload ? new CliGpu(g.gpuWorkload) : { toComfy: async () => {} });
  const flows = new Map(TagsFlow.all(g).map((f) => [f.id, f]));
  const video = new VideoFlow(g);
  const runs = new Runs(comfy, gpu, db, g.outputLibrary, app.log);
  // Tagging takes the GPU for the LLM and starting a run hands it to ComfyUI, so they
  // take turns: a run never unloads the LLM in the middle of a tagging request.
  let gpuTurn: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = gpuTurn.then(fn, fn);
    gpuTurn = p.catch(() => {});
    return p;
  };
  app.addHook('onClose', async () => runs.close());

  const getFlow = (id: string) => {
    const f = flows.get(id);
    if (!f) throw new HttpError('unknown flow', 404);
    return f;
  };

  app.get('/api/generate/flows', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { flows: [...[...flows.values()].map((f) => f.info()), video.info()] };
  });

  app.get('/api/generate/status', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      return { url: g.comfyui, online: true, error: null, ...(await comfy.stats()) };
    } catch (e) {
      return { url: g.comfyui, online: false, error: (e as Error).message, devices: [] };
    }
  });

  app.post('/api/generate/flows/:flow/tags', async (req) => {
    const f = getFlow((req.params as { flow: string }).flow);
    const body = (req.body ?? {}) as { prompt?: unknown; vary?: unknown };
    const prompt = text(body.prompt, 'prompt', MAX_PROMPT);
    const request = f.tagRequest(prompt, body.vary === true);
    return { tags: f.tagsFrom(await exclusive(() => tagger.tags(request))) };
  });

  app.post('/api/generate/flows/:flow/runs', async (req) => {
    const f = getFlow((req.params as { flow: string }).flow);
    const body = (req.body ?? {}) as { prompt?: unknown; variations?: unknown; batch?: unknown };
    // The description is optional: the tags may be typed by hand.
    const prompt = text(body.prompt ?? '', 'prompt', MAX_PROMPT, true);
    if (!Array.isArray(body.variations) || body.variations.length < 1 || body.variations.length > MAX_VARIATIONS) {
      throw new HttpError(`variations must be a list of 1-${MAX_VARIATIONS} tag strings`, 400);
    }
    const variations = body.variations.map((v, i) => text(v, `variation ${i + 1}`, MAX_TAGS));
    const batch = Number(body.batch);
    if (!Number.isInteger(batch) || batch < 1 || batch > MAX_BATCH) throw new HttpError(`batch must be an integer 1-${MAX_BATCH}`, 400);
    return runs.json(await exclusive(() => runs.start(f.source(), prompt, variations, batch)));
  });

  // The video flow's input: an image path pasted from the viewer's "Copy path".
  app.post('/api/generate/video/image', async (req) => {
    const body = (req.body ?? {}) as { path?: unknown };
    return { asset: (await imageAt(req, text(body.path, 'path', 4096))).asset };
  });

  app.post(`/api/generate/flows/${video.id}/runs`, async (req) => {
    const body = (req.body ?? {}) as { prompt?: unknown; image?: unknown; seconds?: unknown; batch?: unknown };
    const prompt = text(body.prompt, 'prompt', MAX_VIDEO_PROMPT);
    const seconds = Number(body.seconds);
    if (!VIDEO_SECONDS.includes(seconds)) throw new HttpError(`seconds must be one of ${VIDEO_SECONDS.join(', ')}`, 400);
    const batch = Number(body.batch ?? 1);
    if (!Number.isInteger(batch) || batch < 1 || batch > MAX_VIDEO_BATCH) throw new HttpError(`batch must be an integer 1-${MAX_VIDEO_BATCH}`, 400);
    const img = await imageAt(req, text(body.image, 'image', 4096));
    if (!img.row.width || !img.row.height) throw new HttpError('the image has not been indexed yet; try again in a moment', 409);
    // ComfyUI loads images from its input and output folders by name ("<rel> [output]"
    // for the latter), so those are used in place. Others are uploaded to the input
    // folder, named after their content so picking the same image again reuses the upload.
    const inPlace = img.row.library_id === g.inputLibrary ? img.row.rel_path
      : img.row.library_id === g.outputLibrary ? `${img.row.rel_path} [output]` : null;
    const name = inPlace ?? `wg_${img.row.fingerprint.slice(0, 16)}${path.extname(img.row.name).toLowerCase()}`;
    const source = video.source({ image: name, sourcePath: img.file, width: img.row.width, height: img.row.height, seconds });
    return runs.json(await exclusive(async () => {
      source.check();
      if (!inPlace) await comfy.upload(img.file, name);
      return runs.start(source, prompt, [prompt], batch, { sourcePath: img.file, sourceAsset: img.row.id, seconds });
    }));
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
