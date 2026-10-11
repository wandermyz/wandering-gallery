import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { GenerateConfig, LoraFlowConfig } from '../config.js';
import { HttpError } from '../paths.js';
import type { Graph } from './comfy.js';

/**
 * Prompt → Danbooru tags (Qwen, inside ComfyUI) → images with WAI-Illustrious.
 *
 * The graph templates are in the repo with every prompt blanked; the prompt texts
 * come from a local YAML file that is never committed:
 * `<promptsDir>/wai-illustrious-tags.yaml`. LoRA flows (`generate.loras` in the
 * config) share that file and use the same graph with a LoRA loader (node 15); an
 * optional `<promptsDir>/<flow id>.yaml` overrides any of its keys (e.g. traits that
 * suit the subject).
 */
export const FLOW_ID = 'wai-illustrious-tags';
const PROMPTS_NAME = FLOW_ID;

export interface FlowInfo {
  id: string;
  title: string;
  ready: boolean;
  /** Why the flow cannot run yet (missing files or keys). */
  problem: string | null;
  promptsFile: string;
}

export interface FlowPrompts {
  /** Tagger system prompt (node 9). */
  systemPrompt: string;
  /** Appended to the system prompt for variations 2…N. */
  variationInstruction: string;
  /** Each list contributes one random "suggested trait" to a variation. */
  traits: string[][];
  /** Prefixed to the tags in the positive prompt (node 12). */
  qualityTags: string;
  /** Negative prompt (node 3). */
  negativePrompt: string;
}

// Node ids in comfyui/workflows/wai-illustrious-tags.{api,ui}.json; the -lora-tags
// variant adds the LoRA loader.
const N = {
  positive: '2', negative: '3', sampler: '5', save: '7',
  prompt: '8', system: '9', qwen: '10', tagger: '11', quality: '12', concat: '13', preview: '14', lora: '15',
} as const;
const TAG_NODES = [N.prompt, N.system, N.qwen, N.tagger];

export const PROMPT_KEYS: (keyof FlowPrompts)[] = ['systemPrompt', 'variationInstruction', 'traits', 'qualityTags', 'negativePrompt'];

export const MAX_PROMPT = 4000;
export const MAX_TAGS = 4000;

export class TagsFlow {
  readonly id: string;
  readonly title: string;
  readonly promptsFile: string;
  /** Optional per-flow overrides of the shared prompts file (LoRA flows only). */
  private readonly overridesFile: string | null;
  private readonly apiFile: string;
  private readonly uiFile: string;

  constructor(cfg: GenerateConfig, private readonly lora: LoraFlowConfig | null = null) {
    this.id = lora ? `wai-illustrious-lora-${lora.id}` : FLOW_ID;
    this.title = lora ? `WAI-Illustrious · ${lora.title}` : 'WAI-Illustrious · prompt to tags';
    const template = lora ? 'wai-illustrious-lora-tags' : FLOW_ID;
    this.promptsFile = path.join(cfg.promptsDir, `${PROMPTS_NAME}.yaml`);
    this.overridesFile = lora ? path.join(cfg.promptsDir, `${this.id}.yaml`) : null;
    this.apiFile = path.join(cfg.workflowsDir, `${template}.api.json`);
    this.uiFile = path.join(cfg.workflowsDir, `${template}.ui.json`);
  }

  /** The prompt-to-tags flow plus one per configured LoRA. */
  static all(cfg: GenerateConfig): TagsFlow[] {
    return [new TagsFlow(cfg), ...cfg.loras.map((l) => new TagsFlow(cfg, l))];
  }

  info(): FlowInfo {
    let problem: string | null = null;
    try {
      this.load();
    } catch (e) {
      problem = (e as Error).message;
    }
    return { id: this.id, title: this.title, ready: !problem, problem, promptsFile: this.promptsFile };
  }

  /** Reads templates and prompts on every use, so edits apply without a restart. */
  load(): { api: Graph; ui: UiWorkflow; prompts: FlowPrompts } {
    const readJson = <T>(file: string): T => {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
      } catch (e) {
        throw new HttpError(`cannot read workflow ${file}: ${(e as Error).message}`, 500);
      }
    };
    return { api: readJson<Graph>(this.apiFile), ui: readJson<UiWorkflow>(this.uiFile), prompts: this.prompts() };
  }

  prompts(): FlowPrompts {
    let text: string;
    try {
      text = fs.readFileSync(this.promptsFile, 'utf8');
    } catch {
      throw new HttpError(`prompts file not found: ${this.promptsFile} (keys: ${PROMPT_KEYS.join(', ')})`, 409);
    }
    if (!this.overridesFile || !fs.existsSync(this.overridesFile)) return parsePrompts(text, this.promptsFile);
    const base = parseYamlObject(text, this.promptsFile);
    const over = parseYamlObject(fs.readFileSync(this.overridesFile, 'utf8'), this.overridesFile);
    return parsePrompts(YAML.stringify({ ...base, ...over }), `${this.promptsFile} + ${this.overridesFile}`);
  }

  /** The tagging part of the workflow, ending in a text preview. */
  tagGraph(description: string, vary: boolean, rand = Math.random): Graph {
    const { api, prompts } = this.load();
    const g: Graph = structuredClone(Object.fromEntries(TAG_NODES.map((k) => [k, api[k]])));
    g[N.prompt].inputs.value = description;
    g[N.system].inputs.value = prompts.systemPrompt;
    if (vary) {
      // A distinct-looking character: suggested traits plus sampling instead of greedy decoding.
      g[N.system].inputs.value += `\n\n${prompts.variationInstruction}`;
      const suggested = prompts.traits.map((list) => list[Math.floor(rand() * list.length)]).join(', ');
      if (suggested) g[N.prompt].inputs.value += `\n\nSuggested traits: ${suggested}`;
      Object.assign(g[N.tagger].inputs, {
        sampling_mode: 'on', 'sampling_mode.temperature': 1.0, 'sampling_mode.top_k': 64, 'sampling_mode.top_p': 0.95,
        'sampling_mode.min_p': 0.05, 'sampling_mode.repetition_penalty': 1.05, 'sampling_mode.seed': randomSeed(),
      });
    }
    g[N.preview] = { class_type: 'PreviewAny', inputs: { source: [N.tagger, 0] } };
    return g;
  }

  /**
   * Picks the tag text out of the tag graph's outputs. LoRA flows put their trigger
   * tags in front, so they are visible and editable with the rest, and drop the
   * tags that don't fit their subject.
   */
  tagsFrom(textOutputs: Record<string, string[]>): string {
    const t = textOutputs[N.preview]?.[0]?.trim();
    if (!t) throw new HttpError('the tagger returned no text', 502);
    if (!this.lora) return t;
    const prefix = splitTags(this.lora.tags);
    const drop = new Set(this.lora.dropTags);
    return [...prefix, ...splitTags(t).filter((x) => !prefix.includes(x) && !drop.has(x.toLowerCase()))].join(', ');
  }

  /**
   * One image job: the literal tags go into the positive prompt so the PNG holds the
   * exact text. The UI workflow (restored by dragging the PNG into ComfyUI) gets the
   * source prompt, the prompt texts and the seed.
   */
  imageJob(description: string, tags: string, seed: number): { graph: Graph; pnginfo: Record<string, unknown> } {
    const { api, ui, prompts } = this.load();
    const g: Graph = structuredClone(api);
    for (const k of [...TAG_NODES, N.quality, N.concat, N.preview]) delete g[k];
    const negative = [prompts.negativePrompt, this.lora?.negative ?? ''].filter(Boolean).join(', ');
    g[N.positive].inputs.text = `${prompts.qualityTags}, ${tags}`;
    g[N.negative].inputs.text = negative;
    g[N.sampler].inputs.seed = seed;
    if (this.lora) {
      if (!g[N.lora]) throw new HttpError(`workflow ${this.apiFile} has no LoRA node ${N.lora}`, 500);
      Object.assign(g[N.lora].inputs, { lora_name: this.lora.lora, strength_model: this.lora.strength });
    }

    const w: UiWorkflow = structuredClone(ui);
    const setWidget = (id: string, value: unknown) => {
      const node = w.nodes.find((n) => String(n.id) === id);
      if (node && Array.isArray(node.widgets_values)) node.widgets_values[0] = value;
    };
    setWidget(N.prompt, description);
    setWidget(N.system, prompts.systemPrompt);
    setWidget(N.quality, prompts.qualityTags);
    setWidget(N.negative, negative);
    setWidget(N.sampler, seed);
    if (this.lora) {
      const node = w.nodes.find((n) => String(n.id) === N.lora);
      if (node) node.widgets_values = [this.lora.lora, this.lora.strength];
    }
    return { graph: g, pnginfo: { workflow: w, source_prompt: description, tags } };
  }
}

const splitTags = (s: string) => s.split(',').map((t) => t.trim()).filter(Boolean);

interface UiWorkflow {
  nodes: { id: number | string; widgets_values?: unknown }[];
  [k: string]: unknown;
}

function parseYamlObject(text: string, file: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (e) {
    throw new HttpError(`invalid YAML in ${file}: ${(e as Error).message}`, 409);
  }
  return (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
}

export function parsePrompts(text: string, file: string): FlowPrompts {
  const o = parseYamlObject(text, file);
  const missing = PROMPT_KEYS.filter((k) => o[k] === undefined || o[k] === null);
  if (missing.length) throw new HttpError(`${file} is missing: ${missing.join(', ')}`, 409);
  const s = (k: keyof FlowPrompts, allowEmpty = false) => {
    const v = o[k];
    if (typeof v !== 'string' || (!allowEmpty && !v.trim())) throw new HttpError(`${file}: ${k} must be ${allowEmpty ? 'a string' : 'a non-empty string'}`, 409);
    return v.trim();
  };
  const traits = o.traits;
  if (!Array.isArray(traits) || traits.some((l) => !Array.isArray(l) || !l.length || l.some((x) => typeof x !== 'string'))) {
    throw new HttpError(`${file}: traits must be a list of non-empty lists of strings`, 409);
  }
  return {
    systemPrompt: s('systemPrompt'),
    variationInstruction: s('variationInstruction'),
    traits: traits as string[][],
    qualityTags: s('qualityTags', true),
    negativePrompt: s('negativePrompt', true),
  };
}

/** A seed in [0, 2^48): plenty of variety and exact in JSON numbers. */
export function randomSeed(): number {
  return crypto.randomInt(0, 2 ** 48 - 1);
}
