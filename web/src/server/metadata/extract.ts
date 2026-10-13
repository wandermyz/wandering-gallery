import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { readExifStrings, readPngInfo } from './readers.js';
import { parseJsonLoose, summarize, searchText, type GenerationSummary } from './comfyui.js';
import { run } from '../proc.js';
import type { MediaKind } from '../media.js';
import { markdownSummary, readMarkdown } from '../markdown.js';

export interface Extracted {
  width: number | null;
  height: number | null;
  duration: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  animated: boolean;
  promptJson: string | null;
  workflowJson: string | null;
  parameters: string | null;
  /** Other embedded text entries that were not interpreted (kept for display). */
  extra: Record<string, string>;
  summary: GenerationSummary | null;
  searchText: string;
}

export interface ExtractOptions {
  ffprobe: string;
}

const MAX_EXTRA_VALUE = 256 * 1024;

/** Stores JSON as compact canonical text, or the raw string if it does not parse. */
function normaliseJson(v: string | undefined): { text: string | null; parsed: unknown } {
  if (v === undefined || v === '') return { text: null, parsed: undefined };
  const parsed = parseJsonLoose(v);
  if (parsed === undefined || typeof parsed !== 'object') return { text: v, parsed: undefined };
  return { text: JSON.stringify(parsed), parsed };
}

function build(base: Partial<Extracted>, text: Record<string, string>): Extracted {
  const prompt = normaliseJson(text.prompt);
  const workflow = normaliseJson(text.workflow);
  const parameters = text.parameters ?? null;
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(text)) {
    if (k === 'prompt' || k === 'workflow' || k === 'parameters') continue;
    extra[k] = v.length > MAX_EXTRA_VALUE ? v.slice(0, MAX_EXTRA_VALUE) + '…' : v;
  }
  let summary: GenerationSummary | null = null;
  try {
    summary = summarize({ prompt: prompt.parsed, workflow: workflow.parsed, parameters: parameters ?? undefined });
  } catch {
    summary = null; // Raw JSON is still stored and shown.
  }
  return {
    width: null, height: null, duration: null, videoCodec: null, audioCodec: null, animated: false,
    ...base,
    promptJson: prompt.text,
    workflowJson: workflow.text,
    parameters,
    extra,
    summary,
    searchText: searchText(summary),
  };
}

/**
 * EXIF strings written by ComfyUI's WebP/AVIF savers look like
 * `workflow:{...}` / `prompt:{...}` in Make/Model/ImageDescription tags.
 */
function textFromExif(exif: Buffer | undefined): Record<string, string> {
  if (!exif) return {};
  const out: Record<string, string> = {};
  const tags = readExifStrings(exif);
  for (const [tag, value] of Object.entries(tags)) {
    const m = /^([A-Za-z_][\w ]{0,40}):\s*([[{"][\s\S]*)$/.exec(value);
    if (m) {
      out[m[1]] ??= m[2];
    } else if (Number(tag) === 0x9286 && value.trim()) {
      out.parameters ??= value; // A1111 JPEG/WebP UserComment
    } else if (Number(tag) === 0x010e && value.trim()) {
      out.ImageDescription ??= value;
    }
  }
  return out;
}

async function extractImage(file: string): Promise<Extracted> {
  const ext = path.extname(file).toLowerCase();
  let text: Record<string, string> = {};
  let width: number | null = null;
  let height: number | null = null;
  let animated = false;

  if (ext === '.png') {
    const info = await readPngInfo(file);
    width = info.width || null;
    height = info.height || null;
    text = info.text;
  }
  // sharp reads headers only here (no pixel decode).
  try {
    const meta = await sharp(file, { animated: true, limitInputPixels: false }).metadata();
    width ??= meta.width ?? null;
    height ??= meta.pageHeight ?? meta.height ?? null;
    animated = (meta.pages ?? 1) > 1;
    if (ext !== '.png') text = { ...textFromExif(meta.exif), ...text };
    if (meta.comments) for (const c of meta.comments) text[c.keyword] ??= c.text;
  } catch (err) {
    if (width === null) throw err;
  }
  return build({ width, height, animated }, text);
}

interface ProbeOutput {
  streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; duration?: string; tags?: Record<string, string> }[];
  format?: { duration?: string; tags?: Record<string, string> };
}

async function extractVideo(file: string, opts: ExtractOptions): Promise<Extracted> {
  const { stdout } = await run(opts.ffprobe, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path.resolve(file),
  ], { timeoutMs: 30_000 });
  const probe = JSON.parse(stdout.toString('utf8')) as ProbeOutput;
  const video = probe.streams?.find((s) => s.codec_type === 'video');
  const audio = probe.streams?.find((s) => s.codec_type === 'audio');
  const duration = Number(probe.format?.duration ?? video?.duration);
  const tags: Record<string, string> = {};
  // Tag keys are case-insensitive in some containers (Matroska upper-cases them).
  for (const [k, v] of Object.entries(probe.format?.tags ?? {})) {
    const key = k.toLowerCase();
    if (['major_brand', 'minor_version', 'compatible_brands', 'encoder', 'creation_time', 'handler_name', 'vendor_id', 'duration'].includes(key)) continue;
    tags[key === 'prompt' || key === 'workflow' || key === 'parameters' ? key : k] = v;
  }
  // VHS (VideoHelperSuite) stores the editor workflow and prompt inside a "comment" JSON.
  if (!tags.prompt && !tags.workflow && tags.comment) {
    const c = parseJsonLoose(tags.comment);
    if (c && typeof c === 'object' && !Array.isArray(c)) {
      const o = c as Record<string, unknown>;
      if (o.prompt !== undefined) tags.prompt = typeof o.prompt === 'string' ? o.prompt : JSON.stringify(o.prompt);
      if (o.workflow !== undefined) tags.workflow = typeof o.workflow === 'string' ? o.workflow : JSON.stringify(o.workflow);
      if (tags.prompt || tags.workflow) delete tags.comment;
    }
  }
  return build({
    width: video?.width ?? null,
    height: video?.height ?? null,
    duration: Number.isFinite(duration) ? duration : null,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
  }, tags);
}

export async function extract(file: string, kind: MediaKind, opts: ExtractOptions): Promise<Extracted> {
  await fs.promises.access(file, fs.constants.R_OK);
  if (kind === 'markdown') return extractMarkdown(file);
  return kind === 'video' ? extractVideo(file, opts) : extractImage(file);
}

/** Documents carry no generation metadata; their text goes into the search index. */
async function extractMarkdown(file: string): Promise<Extracted> {
  const { title, body } = markdownSummary(await readMarkdown(file));
  return { ...build({}, {}), searchText: [title, body].filter(Boolean).join('\n').toLowerCase().slice(0, 64 * 1024) };
}
