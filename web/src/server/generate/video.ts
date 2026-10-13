import fs from 'node:fs';
import path from 'node:path';
import type { GenerateConfig } from '../config.js';
import { HttpError } from '../paths.js';
import type { Graph } from './comfy.js';
import type { FlowInfo } from './flow.js';
import type { JobSource } from './runs.js';

/**
 * Image + prompt → video with sound, with MiniMax H3 (first-frame image-to-video) in
 * ComfyUI: `comfyui/workflows/minimax-h3-i2v.{api,ui}.json`, the official template with
 * the 8-step turbo LoRA on. The input image is uploaded to ComfyUI's input folder.
 * Resolution and sampling are the template's defaults; only the length is chosen.
 */
export const VIDEO_FLOW_ID = 'minimax-h3-i2v';
const TEMPLATE = 'minimax-h3-i2v';

/** Clip lengths offered, in seconds. H3 is trained on about 5-15 s. */
export const VIDEO_SECONDS = [5, 8, 10, 12, 15];
export const DEFAULT_SECONDS = 5;
export const MAX_VIDEO_PROMPT = 8000;

// Node ids in the API template, and the subgraph / LoadImage nodes of the UI one.
const N = { video: '6', noise: '7', image: '16' } as const;
const UI = { subgraph: 105, image: 114 } as const;

const FPS = 24;
// The model's canvas: a 768 px short edge, at most 768×1344, both multiples of 32.
const SHORT_EDGE = 768;
const MAX_PIXELS = 768 * 1344;
const MULTIPLE = 32;

/** Frame count for a length in seconds, snapped up to H3's 17k+5 grid (as the template does). */
export function videoFrames(seconds: number): number {
  const n = Math.max(5, Math.round(seconds * FPS));
  return n + ((5 - (n % 17)) % 17 + 17) % 17;
}

/** H3's native canvas for an input image's aspect ratio (ComfyUI's `adapt_canvas`). */
export function videoCanvas(width: number, height: number): { width: number; height: number } {
  const ratio = width / height;
  let [w, h] = ratio >= 1 ? [SHORT_EDGE * ratio, SHORT_EDGE] : [SHORT_EDGE, SHORT_EDGE / ratio];
  if (w * h > MAX_PIXELS) {
    const s = Math.sqrt(MAX_PIXELS / (w * h));
    [w, h] = [w * s, h * s];
  }
  const snap = (x: number) => Math.max(MULTIPLE, Math.round(x / MULTIPLE) * MULTIPLE);
  return { width: snap(w), height: snap(h) };
}

interface UiWorkflow {
  nodes: { id: number | string; widgets_values?: unknown[] }[];
  [k: string]: unknown;
}

export interface VideoRequest {
  /** The input image's name in ComfyUI's input folder. */
  image: string;
  /** Where it came from, kept in the video's metadata. */
  sourcePath: string;
  width: number;
  height: number;
  seconds: number;
}

export class VideoFlow {
  readonly id = VIDEO_FLOW_ID;
  readonly title = 'MiniMax H3 · image to video';
  private readonly apiFile: string;
  private readonly uiFile: string;

  constructor(cfg: GenerateConfig) {
    this.apiFile = path.join(cfg.workflowsDir, `${TEMPLATE}.api.json`);
    this.uiFile = path.join(cfg.workflowsDir, `${TEMPLATE}.ui.json`);
  }

  info(): FlowInfo {
    let problem: string | null = null;
    try {
      this.load();
    } catch (e) {
      problem = (e as Error).message;
    }
    return { id: this.id, title: this.title, kind: 'video', ready: !problem, problem, promptsFile: '', defaultTags: '', seconds: VIDEO_SECONDS, defaultSeconds: DEFAULT_SECONDS };
  }

  /** Reads the templates on every use, so edits apply without a restart. */
  load(): { api: Graph; ui: UiWorkflow } {
    const readJson = <T>(file: string): T => {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
      } catch (e) {
        throw new HttpError(`cannot read workflow ${file}: ${(e as Error).message}`, 500);
      }
    };
    return { api: readJson<Graph>(this.apiFile), ui: readJson<UiWorkflow>(this.uiFile) };
  }

  /** The jobs of one request: every job is the same video with its own seed. */
  source(req: VideoRequest): JobSource {
    return { id: this.id, check: () => void this.load(), job: (prompt, _text, seed) => this.videoJob(req, prompt, seed) };
  }

  videoJob(req: VideoRequest, prompt: string, seed: number): { graph: Graph; pnginfo: Record<string, unknown> } {
    const { api, ui } = this.load();
    const { width, height } = videoCanvas(req.width, req.height);
    const g: Graph = structuredClone(api);
    Object.assign(g[N.video].inputs, { prompt, width, height, length: videoFrames(req.seconds) });
    g[N.noise].inputs.noise_seed = seed;
    g[N.image].inputs.image = req.image;

    // The UI workflow (restored by dragging the video into ComfyUI): the subgraph's
    // widgets are prompt, width, height, duration (s), seed, then the models.
    const w: UiWorkflow = structuredClone(ui);
    const node = (id: number) => w.nodes.find((n) => n.id === id);
    const sub = node(UI.subgraph)?.widgets_values;
    if (sub) sub.splice(0, 5, prompt, width, height, req.seconds, seed);
    const img = node(UI.image)?.widgets_values;
    if (img) img[0] = req.image;
    return { graph: g, pnginfo: { workflow: w, source_image: req.sourcePath } };
  }
}
