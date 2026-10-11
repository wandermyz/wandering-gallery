/**
 * Best-effort interpretation of ComfyUI generation metadata.
 *
 * ComfyUI embeds two documents:
 *  - `prompt`: the executed API graph, `{ [nodeId]: { class_type, inputs, _meta? } }`.
 *    Inputs are literals or links `[sourceNodeId, outputIndex]`.
 *  - `workflow`: the editor graph (nodes with widgets_values, links, groups...).
 *
 * The API prompt is the authoritative record of what actually ran, so we
 * interpret that and fall back to the editor workflow only when it is missing.
 * Workflows can contain any custom node, so nothing here assumes a fixed shape;
 * unknown nodes are simply not summarised, and the raw JSON is always kept.
 */

export type Scalar = string | number | boolean;

export interface SamplerInfo {
  nodeId: string;
  classType: string;
  title?: string;
  seed?: Scalar;
  steps?: Scalar;
  cfg?: Scalar;
  sampler?: Scalar;
  scheduler?: Scalar;
  denoise?: Scalar;
  positive?: string;
  negative?: string;
}

export interface ModelRef {
  kind: 'checkpoint' | 'unet' | 'vae' | 'clip' | 'controlnet' | 'upscale' | 'other';
  name: string;
  nodeId?: string;
}

export interface LoraRef {
  name: string;
  strengthModel?: number;
  strengthClip?: number;
}

export interface GenerationSummary {
  source: 'comfyui' | 'a1111' | 'unknown';
  positive: string[];
  negative: string[];
  /** Prompt-like text found anywhere when it could not be classified as positive/negative. */
  otherText: string[];
  samplers: SamplerInfo[];
  models: ModelRef[];
  loras: LoraRef[];
  /** Flat, display-ready key/value pairs (first sampler, latent size, video settings...). */
  params: Record<string, Scalar>;
  nodeTypes: string[];
}

type Link = [string, number];
interface ApiNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: { title?: string };
}
type ApiPrompt = Record<string, ApiNode>;

const isLink = (v: unknown): v is Link =>
  Array.isArray(v) && v.length === 2 && (typeof v[0] === 'string' || typeof v[0] === 'number') && typeof v[1] === 'number';

const isScalar = (v: unknown): v is Scalar =>
  typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean';

/** Parses JSON that may be double-encoded; returns undefined on failure. */
export function parseJsonLoose(value: unknown): unknown {
  let v = value;
  for (let i = 0; i < 3 && typeof v === 'string'; i++) {
    const t = v.trim();
    if (!t.startsWith('{') && !t.startsWith('[') && !t.startsWith('"')) return i === 0 ? undefined : v;
    try {
      v = JSON.parse(t);
    } catch {
      // Some writers emit NaN/Infinity, which JSON.parse rejects.
      try {
        v = JSON.parse(t.replace(/\bNaN\b|-?\bInfinity\b/g, 'null'));
      } catch {
        return undefined;
      }
    }
  }
  return v;
}

/** Unwraps a value stored as a JSON string literal (e.g. `"\\u5973"`) for display; other text is returned as is. */
export function unquoteJsonString(value: string): string {
  const t = value.trim();
  if (t.length < 2 || !t.startsWith('"') || !t.endsWith('"')) return value;
  try {
    const v = JSON.parse(t);
    return typeof v === 'string' ? v : value;
  } catch {
    return value;
  }
}

export function asApiPrompt(v: unknown): ApiPrompt | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: ApiPrompt = {};
  let count = 0;
  for (const [id, node] of Object.entries(v as Record<string, unknown>)) {
    if (!node || typeof node !== 'object') continue;
    const n = node as Record<string, unknown>;
    if (typeof n.class_type !== 'string') continue;
    out[id] = {
      class_type: n.class_type,
      inputs: n.inputs && typeof n.inputs === 'object' ? (n.inputs as Record<string, unknown>) : {},
      _meta: n._meta as ApiNode['_meta'],
    };
    count++;
  }
  return count ? out : null;
}

const TEXT_KEYS = ['text', 'text_g', 'text_l', 'prompt', 'positive_prompt', 'string', 'value', 'wildcard_text', 'populated_text', 'text_positive'];
const COND_PASS_KEYS = ['conditioning', 'conditioning_to', 'conditioning_1', 'conditioning_from', 'conditioning_2', 'cond', 'positive', 'negative'];

/**
 * Follows a conditioning (or string) link back to the text that produced it.
 * `slot` is the output index of the link, used for nodes that pass both
 * positive (0) and negative (1) through (ControlNet apply, InstructPix2Pix...).
 */
function traceText(prompt: ApiPrompt, link: unknown, seen = new Set<string>(), depth = 0): string[] {
  if (!isLink(link) || depth > 24) return [];
  const id = String(link[0]);
  const slot = link[1];
  const node = prompt[id];
  if (!node || seen.has(`${id}:${slot}`)) return [];
  seen.add(`${id}:${slot}`);
  const inputs = node.inputs;

  // Nodes that hold the text directly (CLIPTextEncode, SDXL encoders, string primitives, ...).
  const texts: string[] = [];
  for (const key of TEXT_KEYS) {
    const v = inputs[key];
    if (typeof v === 'string' && v.trim() !== '') texts.push(v);
    else if (isLink(v)) texts.push(...traceText(prompt, v, seen, depth + 1));
  }
  if (texts.length) return dedupe(texts);

  // Dual-output passthrough nodes: slot 0 = positive, slot 1 = negative.
  if ('positive' in inputs && 'negative' in inputs) {
    return traceText(prompt, slot === 1 ? inputs.negative : inputs.positive, seen, depth + 1);
  }
  // Single-input passthrough / combine nodes.
  const out: string[] = [];
  for (const key of COND_PASS_KEYS) {
    if (isLink(inputs[key])) out.push(...traceText(prompt, inputs[key], seen, depth + 1));
  }
  return dedupe(out);
}

/** Resolves a sampler parameter that may be a literal or a link to a primitive node. */
function resolveScalar(prompt: ApiPrompt, v: unknown, depth = 0): Scalar | undefined {
  if (isScalar(v)) return v;
  if (!isLink(v) || depth > 8) return undefined;
  const node = prompt[String(v[0])];
  if (!node) return undefined;
  const scalars = Object.entries(node.inputs).filter(([, x]) => isScalar(x) || isLink(x));
  for (const key of ['value', 'seed', 'noise_seed', 'int', 'float', 'number', 'string', 'Number']) {
    if (key in node.inputs) return resolveScalar(prompt, node.inputs[key], depth + 1);
  }
  if (scalars.length === 1) return resolveScalar(prompt, scalars[0][1], depth + 1);
  return undefined;
}

const PARAM_KEYS: Record<string, keyof SamplerInfo> = {
  seed: 'seed',
  noise_seed: 'seed',
  steps: 'steps',
  cfg: 'cfg',
  sampler_name: 'sampler',
  scheduler: 'scheduler',
  denoise: 'denoise',
};

/** Inputs of SamplerCustom(Advanced) that point at the nodes holding the actual settings. */
const SAMPLER_COMPONENT_KEYS = ['noise', 'guider', 'sampler', 'sigmas'];

function isSamplerNode(node: ApiNode): boolean {
  const i = node.inputs;
  // Editor-workflow pseudo nodes have widget values but no link inputs.
  if (/^KSampler(Advanced)?$/.test(node.class_type) && ('steps' in i || 'seed' in i || 'noise_seed' in i)) return true;
  if (/sampler/i.test(node.class_type) && ('positive' in i || 'guider' in i || 'latent_image' in i)) return true;
  return ('steps' in i || 'sampler_name' in i) && ('positive' in i || 'model' in i) && ('latent_image' in i || 'latent' in i);
}

function samplerInfo(prompt: ApiPrompt, id: string, node: ApiNode): SamplerInfo {
  const info: SamplerInfo = { nodeId: id, classType: node.class_type, title: node._meta?.title };
  let condNode: ApiNode | null = 'positive' in node.inputs ? node : null;

  const visit = (n: ApiNode, depth: number) => {
    for (const [key, field] of Object.entries(PARAM_KEYS)) {
      if (info[field] === undefined && key in n.inputs) {
        const v = resolveScalar(prompt, n.inputs[key]);
        if (v !== undefined) (info as unknown as Record<string, unknown>)[field] = v;
      }
    }
    if (!condNode && ('positive' in n.inputs || 'conditioning' in n.inputs)) condNode = n;
    if (depth > 3) return;
    for (const key of SAMPLER_COMPONENT_KEYS) {
      const link = n.inputs[key];
      if (isLink(link) && prompt[String(link[0])]) visit(prompt[String(link[0])], depth + 1);
    }
  };
  visit(node, 0);

  const cn = condNode as ApiNode | null;
  if (cn) {
    const pos = traceText(prompt, cn.inputs.positive ?? cn.inputs.conditioning);
    const neg = traceText(prompt, cn.inputs.negative);
    if (pos.length) info.positive = pos.join('\n\n');
    if (neg.length) info.negative = neg.join('\n\n');
  }
  return info;
}

const MODEL_KEYS: Record<string, ModelRef['kind']> = {
  ckpt_name: 'checkpoint',
  unet_name: 'unet',
  model_name: 'other',
  vae_name: 'vae',
  clip_name: 'clip',
  clip_name1: 'clip',
  clip_name2: 'clip',
  clip_name3: 'clip',
  control_net_name: 'controlnet',
};

function modelKind(classType: string, key: string): ModelRef['kind'] {
  const k = MODEL_KEYS[key];
  if (k !== 'other') return k;
  if (/upscale/i.test(classType)) return 'upscale';
  if (/unet|diffusion/i.test(classType)) return 'unet';
  if (/checkpoint/i.test(classType)) return 'checkpoint';
  return 'other';
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function collectLoras(node: ApiNode, out: LoraRef[]) {
  const i = node.inputs;
  if (typeof i.lora_name === 'string' && i.lora_name !== 'None') {
    out.push({ name: i.lora_name, strengthModel: num(i.strength_model ?? i.strength), strengthClip: num(i.strength_clip) });
  }
  for (const [key, v] of Object.entries(i)) {
    // rgthree "Power Lora Loader": lora_1: { on, lora, strength, strengthTwo }
    if (/^lora_\d+$/i.test(key) && v && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      if (o.on !== false && typeof o.lora === 'string' && o.lora !== 'None') {
        out.push({ name: o.lora, strengthModel: num(o.strength), strengthClip: num(o.strengthTwo ?? o.strength) });
      }
    }
    // Efficiency / stacker nodes: lora_name_1, lora_wt_1 / model_str_1, clip_str_1
    const m = /^lora_name_(\d+)$/.exec(key);
    if (m && typeof v === 'string' && v !== 'None') {
      const n = m[1];
      out.push({
        name: v,
        strengthModel: num(i[`lora_wt_${n}`] ?? i[`model_str_${n}`]),
        strengthClip: num(i[`clip_str_${n}`]),
      });
    }
  }
}

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

export function summarizeApiPrompt(prompt: ApiPrompt): GenerationSummary {
  const ids = Object.keys(prompt).sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
  const summary: GenerationSummary = {
    source: 'comfyui',
    positive: [],
    negative: [],
    otherText: [],
    samplers: [],
    models: [],
    loras: [],
    params: {},
    nodeTypes: dedupe(ids.map((id) => prompt[id].class_type)).sort(),
  };

  for (const id of ids) {
    const node = prompt[id];
    if (isSamplerNode(node)) summary.samplers.push(samplerInfo(prompt, id, node));
    // Only loader nodes name models; preprocessors also use e.g. `ckpt_name` for their own weights.
    const isLoader = /load/i.test(node.class_type);
    for (const [key, value] of Object.entries(node.inputs)) {
      if (isLoader && key in MODEL_KEYS && typeof value === 'string' && value !== 'None') {
        summary.models.push({ kind: modelKind(node.class_type, key), name: value, nodeId: id });
      }
    }
    collectLoras(node, summary.loras);
  }

  for (const s of summary.samplers) {
    if (s.positive) summary.positive.push(s.positive);
    if (s.negative) summary.negative.push(s.negative);
  }
  summary.positive = dedupe(summary.positive);
  summary.negative = dedupe(summary.negative).filter((n) => !summary.positive.includes(n));

  // Any text-encoder text not reached from a sampler is still worth showing.
  const known = new Set([...summary.positive, ...summary.negative].flatMap((t) => t.split('\n\n')));
  for (const id of ids) {
    const node = prompt[id];
    if (!/text|prompt|string/i.test(node.class_type)) continue;
    for (const key of TEXT_KEYS) {
      const v = node.inputs[key];
      if (typeof v === 'string' && v.trim() && !known.has(v)) {
        known.add(v);
        summary.otherText.push(v);
      }
    }
  }

  const first = summary.samplers[0];
  if (first) {
    for (const k of ['seed', 'steps', 'cfg', 'sampler', 'scheduler', 'denoise'] as const) {
      if (first[k] !== undefined) summary.params[k] = first[k]!;
    }
  }
  for (const id of ids) {
    const { class_type, inputs } = prompt[id];
    if (/latent/i.test(class_type) && typeof inputs.width === 'number' && typeof inputs.height === 'number') {
      summary.params.width ??= inputs.width;
      summary.params.height ??= inputs.height;
      if (typeof inputs.batch_size === 'number') summary.params.batch_size ??= inputs.batch_size;
      if (typeof inputs.length === 'number') summary.params.frames ??= inputs.length;
    }
    for (const key of ['fps', 'frame_rate']) {
      if (typeof inputs[key] === 'number') summary.params.fps ??= inputs[key] as number;
    }
    if (/upscale/i.test(class_type) && typeof inputs.scale_by === 'number') summary.params.upscale_by ??= inputs.scale_by;
    if (class_type.startsWith('ModelSampling') && typeof inputs.shift === 'number') summary.params.shift ??= inputs.shift;
    if (/guidance/i.test(class_type) && typeof inputs.guidance === 'number') summary.params.guidance ??= inputs.guidance;
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Editor workflow fallback (only used when no API prompt is present).

interface WfNode {
  id: number | string;
  type: string;
  title?: string;
  mode?: number;
  widgets_values?: unknown;
}

/** widgets_values positions for the core nodes. `null` = control widget (e.g. "randomize"). */
const WIDGET_LAYOUT: Record<string, (string | null)[]> = {
  KSampler: ['seed', null, 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise'],
  KSamplerAdvanced: ['add_noise', 'noise_seed', null, 'steps', 'cfg', 'sampler_name', 'scheduler', 'start_at_step', 'end_at_step', 'return_with_leftover_noise'],
  CheckpointLoaderSimple: ['ckpt_name'],
  UNETLoader: ['unet_name', 'weight_dtype'],
  VAELoader: ['vae_name'],
  LoraLoader: ['lora_name', 'strength_model', 'strength_clip'],
  LoraLoaderModelOnly: ['lora_name', 'strength_model'],
  EmptyLatentImage: ['width', 'height', 'batch_size'],
  EmptySD3LatentImage: ['width', 'height', 'batch_size'],
  RandomNoise: ['noise_seed', null],
  KSamplerSelect: ['sampler_name'],
  BasicScheduler: ['scheduler', 'steps', 'denoise'],
  CFGGuider: ['cfg'],
};

/** Converts an editor workflow into a pseudo API prompt using known widget layouts. */
export function workflowToPseudoPrompt(workflow: unknown): ApiPrompt | null {
  if (!workflow || typeof workflow !== 'object') return null;
  const wf = workflow as { nodes?: unknown; links?: unknown };
  if (!Array.isArray(wf.nodes)) return null;
  const out: ApiPrompt = {};
  for (const raw of wf.nodes as WfNode[]) {
    if (!raw || typeof raw.type !== 'string') continue;
    if (raw.mode === 2 || raw.mode === 4) continue; // muted / bypassed
    const inputs: Record<string, unknown> = {};
    const values = Array.isArray(raw.widgets_values) ? raw.widgets_values : [];
    const layout = WIDGET_LAYOUT[raw.type];
    if (layout) {
      layout.forEach((key, i) => {
        if (key && i < values.length) inputs[key] = values[i];
      });
    } else if (/CLIPTextEncode|Prompt|Text/i.test(raw.type) && typeof values[0] === 'string') {
      inputs.text = values[0];
    }
    out[String(raw.id)] = { class_type: raw.type, inputs, _meta: raw.title ? { title: raw.title } : undefined };
  }
  return Object.keys(out).length ? out : null;
}

// ---------------------------------------------------------------------------
// Automatic1111 / Forge "parameters" text, occasionally seen in mixed libraries.

export function summarizeA1111(text: string): GenerationSummary {
  const summary: GenerationSummary = {
    source: 'a1111', positive: [], negative: [], otherText: [], samplers: [], models: [], loras: [], params: {}, nodeTypes: [],
  };
  const lines = text.split('\n');
  let paramLine = '';
  if (lines.length && /^Steps: /.test(lines[lines.length - 1])) paramLine = lines.pop()!;
  const body = lines.join('\n');
  const negIdx = body.indexOf('Negative prompt:');
  const pos = (negIdx >= 0 ? body.slice(0, negIdx) : body).trim();
  const neg = negIdx >= 0 ? body.slice(negIdx + 'Negative prompt:'.length).trim() : '';
  if (pos) summary.positive.push(pos);
  if (neg) summary.negative.push(neg);
  for (const m of pos.matchAll(/<lora:([^:>]+):?([\d.]+)?>/g)) {
    summary.loras.push({ name: m[1], strengthModel: m[2] ? Number(m[2]) : undefined });
  }
  const map: Record<string, string> = {
    Steps: 'steps', Sampler: 'sampler', 'Schedule type': 'scheduler', 'CFG scale': 'cfg', Seed: 'seed',
    'Denoising strength': 'denoise',
  };
  for (const m of paramLine.matchAll(/([A-Za-z][\w ]*?): ("[^"]*"|[^,]*)(?:,|$)/g)) {
    const key = m[1].trim();
    const raw = m[2].trim().replace(/^"|"$/g, '');
    const n = Number(raw);
    const val: Scalar = raw !== '' && Number.isFinite(n) ? n : raw;
    if (key === 'Model') summary.models.push({ kind: 'checkpoint', name: raw });
    else if (key === 'Size') {
      const [w, h] = raw.split('x').map(Number);
      if (w && h) Object.assign(summary.params, { width: w, height: h });
    } else summary.params[map[key] ?? key] = val;
  }
  if (summary.params.steps !== undefined) {
    summary.samplers.push({
      nodeId: '', classType: 'A1111',
      seed: summary.params.seed, steps: summary.params.steps, cfg: summary.params.cfg,
      sampler: summary.params.sampler, scheduler: summary.params.scheduler,
      positive: pos || undefined, negative: neg || undefined,
    });
  }
  return summary;
}

export interface RawGenerationData {
  prompt?: unknown;
  workflow?: unknown;
  parameters?: string;
}

/** Produces a summary from whatever raw data was found, or null if nothing usable. */
export function summarize(raw: RawGenerationData): GenerationSummary | null {
  const api = asApiPrompt(raw.prompt);
  if (api) return summarizeApiPrompt(api);
  const pseudo = workflowToPseudoPrompt(raw.workflow);
  if (pseudo) return summarizeApiPrompt(pseudo);
  if (raw.parameters) return summarizeA1111(raw.parameters);
  return null;
}

/** Flattens a summary into lowercase text for future search indexing. */
export function searchText(s: GenerationSummary | null): string {
  if (!s) return '';
  return [
    ...s.positive, ...s.negative, ...s.otherText,
    ...s.models.map((m) => m.name), ...s.loras.map((l) => l.name),
    ...s.samplers.flatMap((x) => [x.sampler, x.scheduler, x.seed].filter((v) => v !== undefined).map(String)),
  ].join('\n').toLowerCase();
}
