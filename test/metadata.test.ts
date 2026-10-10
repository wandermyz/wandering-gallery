import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { summarize, summarizeA1111, workflowToPseudoPrompt, parseJsonLoose } from '../src/server/metadata/comfyui.js';
import { extract } from '../src/server/metadata/extract.js';
import { readPngInfo, readExifStrings } from '../src/server/metadata/readers.js';
import { FFPROBE, fixture, hasFfmpeg, makeExif, makePng, makeVideo, makeWebp, tmpDir } from './helpers.js';

const json = (name: string) => JSON.parse(fixture(name));

describe('ComfyUI API prompt interpretation', () => {
  it('extracts prompts and sampler settings from a basic SDXL graph', () => {
    const s = summarize({ prompt: json('sdxl-basic.prompt.json') })!;
    expect(s.source).toBe('comfyui');
    expect(s.positive).toEqual(['a lighthouse on a cliff at dusk, dramatic sky, highly detailed']);
    expect(s.negative).toEqual(['blurry, lowres, watermark']);
    expect(s.params).toMatchObject({ seed: 123456789, steps: 28, cfg: 5.5, sampler: 'euler', scheduler: 'normal', denoise: 1, width: 832, height: 1216 });
    expect(s.models).toEqual([{ kind: 'checkpoint', name: 'sdxl_base_1.0.safetensors', nodeId: '1' }]);
    expect(s.samplers).toHaveLength(1);
  });

  it('follows conditioning through ControlNet and collects chained LoRAs', () => {
    const s = summarize({ prompt: json('controlnet-lora.prompt.json') })!;
    expect(s.positive).toEqual(['1girl, sitting on a beach, sunset']);
    expect(s.negative).toEqual(['worst quality, bad hands']);
    expect(s.params).toMatchObject({ seed: 777, steps: 30, cfg: 6, sampler: 'euler_ancestral', scheduler: 'karras' });
    expect(s.loras).toEqual([
      { name: 'style_watercolor.safetensors', strengthModel: 0.8, strengthClip: 0.6 },
      { name: 'detail_tweaker.safetensors', strengthModel: 0.4, strengthClip: 0.4 },
    ]);
    expect(s.models.map((m) => m.kind).sort()).toEqual(['checkpoint', 'controlnet']);
  });

  it('handles SamplerCustomAdvanced graphs with linked primitives (Flux style)', () => {
    const s = summarize({ prompt: json('flux-custom-sampler.prompt.json') })!;
    expect(s.positive).toEqual(['a red fox in fresh snow, morning light']);
    expect(s.negative).toEqual([]);
    expect(s.params).toMatchObject({ seed: 42, steps: 20, sampler: 'euler', scheduler: 'simple', guidance: 3.5, width: 1024, height: 1024 });
    expect(s.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'unet', name: 'flux1-dev.safetensors' }),
      expect.objectContaining({ kind: 'vae', name: 'ae.safetensors' }),
      expect.objectContaining({ kind: 'clip', name: 't5xxl_fp16.safetensors' }),
    ]));
    // rgthree Power Lora Loader: disabled entries are skipped.
    expect(s.loras).toEqual([{ name: 'fox_style.safetensors', strengthModel: 0.9, strengthClip: 0.9 }]);
  });

  it('extracts video generation settings (Wan)', () => {
    const s = summarize({ prompt: json('wan-video.prompt.json') })!;
    expect(s.positive[0]).toMatch(/paper boat/);
    expect(s.params).toMatchObject({ seed: 98765, steps: 30, sampler: 'uni_pc', frames: 81, fps: 16, shift: 8, width: 480, height: 704 });
  });

  it('falls back to the editor workflow when no API prompt exists, skipping bypassed nodes', () => {
    const pseudo = workflowToPseudoPrompt(json('sdxl-basic.workflow.json'))!;
    expect(Object.values(pseudo).some((n) => n.class_type === 'LoraLoader')).toBe(false);
    const s = summarize({ workflow: json('sdxl-basic.workflow.json') })!;
    expect(s.params).toMatchObject({ seed: 123456789, steps: 28, cfg: 5.5, sampler: 'euler', scheduler: 'normal' });
    expect(s.models[0].name).toBe('sdxl_base_1.0.safetensors');
    // Without links the prompts cannot be classified, but the text is not lost.
    expect([...s.positive, ...s.otherText]).toContain('blurry, lowres, watermark');
  });

  it('produces a summary for graphs made only of unknown custom nodes without throwing', () => {
    const s = summarize({ prompt: json('custom-only.prompt.json') })!;
    expect(s.samplers).toEqual([]);
    expect(s.nodeTypes).toEqual(['MysteryCustomGenerator', 'SaveImage']);
  });

  it('survives cyclic or malformed graphs', () => {
    const cyclic = {
      1: { class_type: 'ConditioningCombine', inputs: { conditioning_1: ['2', 0], conditioning_2: ['1', 0] } },
      2: { class_type: 'ConditioningCombine', inputs: { conditioning_1: ['1', 0] } },
      3: { class_type: 'KSampler', inputs: { seed: 1, steps: 2, positive: ['1', 0], negative: ['99', 0], model: ['x', 0], latent_image: ['4', 0] } },
      4: 'garbage',
    };
    const s = summarize({ prompt: cyclic })!;
    expect(s.samplers[0].seed).toBe(1);
    expect(summarize({ prompt: 'not json at all' })).toBeNull();
    expect(summarize({ prompt: [1, 2, 3] })).toBeNull();
  });

  it('parses JSON leniently (double-encoded, NaN)', () => {
    expect(parseJsonLoose(JSON.stringify(JSON.stringify({ a: 1 })))).toEqual({ a: 1 });
    expect(parseJsonLoose('{"a": NaN}')).toEqual({ a: null });
    expect(parseJsonLoose('{broken')).toBeUndefined();
  });

  it('parses A1111 parameters text', () => {
    const s = summarizeA1111('a cat <lora:cute:0.7>\nNegative prompt: ugly\nSteps: 20, Sampler: DPM++ 2M, CFG scale: 7, Seed: 5, Size: 512x768, Model: dream');
    expect(s.positive).toEqual(['a cat <lora:cute:0.7>']);
    expect(s.negative).toEqual(['ugly']);
    expect(s.params).toMatchObject({ steps: 20, sampler: 'DPM++ 2M', cfg: 7, seed: 5, width: 512, height: 768 });
    expect(s.loras).toEqual([{ name: 'cute', strengthModel: 0.7 }]);
    expect(s.models).toEqual([{ kind: 'checkpoint', name: 'dream' }]);
  });
});

describe('embedded metadata readers', () => {
  it.each(['tEXt', 'zTXt', 'iTXt'] as const)('reads ComfyUI PNG %s chunks and keeps raw JSON', async (kind) => {
    const dir = tmpDir();
    const file = path.join(dir, 'a.png');
    const prompt = fixture('sdxl-basic.prompt.json');
    const workflow = fixture('sdxl-basic.workflow.json');
    await makePng(file, { w: 40, h: 30, text: { prompt, workflow }, kind });
    const info = await readPngInfo(file);
    expect(info).toMatchObject({ width: 40, height: 30, complete: true });
    expect(JSON.parse(info.text.prompt)).toEqual(JSON.parse(prompt));

    const x = await extract(file, 'image', { ffprobe: FFPROBE });
    expect(x.width).toBe(40);
    expect(JSON.parse(x.promptJson!)).toEqual(JSON.parse(prompt));
    expect(JSON.parse(x.workflowJson!)).toEqual(JSON.parse(workflow));
    expect(x.summary?.params.seed).toBe(123456789);
    expect(x.searchText).toContain('lighthouse');
  });

  it('decodes non-ASCII prompts written as UTF-8 in tEXt chunks', async () => {
    const file = path.join(tmpDir(), 'u.png');
    const prompt = JSON.stringify({ 1: { class_type: 'CLIPTextEncode', inputs: { text: '桜の木の下で、微笑む少女 ✨' } } });
    await makePng(file, { text: { prompt } });
    const x = await extract(file, 'image', { ffprobe: FFPROBE });
    expect(x.summary?.otherText).toEqual(['桜の木の下で、微笑む少女 ✨']);
  });

  it('keeps unparseable metadata as raw text instead of discarding it', async () => {
    const file = path.join(tmpDir(), 'bad.png');
    await makePng(file, { text: { prompt: '{"truncated": ', workflow: 'not json', Comment: 'hello' } });
    const x = await extract(file, 'image', { ffprobe: FFPROBE });
    expect(x.promptJson).toBe('{"truncated": ');
    expect(x.workflowJson).toBe('not json');
    expect(x.extra).toEqual({ Comment: 'hello' });
    expect(x.summary).toBeNull();
  });

  it('reads ComfyUI-style EXIF metadata from WebP', async () => {
    const file = path.join(tmpDir(), 'a.webp');
    const prompt = fixture('controlnet-lora.prompt.json').replace(/\s+/g, ' ');
    await makeWebp(file, { 0x0110: `prompt:${prompt}`, 0x010f: 'workflow:{"nodes": []}' });
    const x = await extract(file, 'image', { ffprobe: FFPROBE });
    expect(x.width).toBe(80);
    expect(x.summary?.params.seed).toBe(777);
    expect(x.workflowJson).toBe('{"nodes":[]}');
  });

  it('parses raw EXIF blocks defensively', () => {
    const exif = makeExif({ 0x0110: 'prompt:{"a":1}', 0x010f: 'Canon' });
    expect(readExifStrings(exif)).toEqual({ 0x0110: 'prompt:{"a":1}', 0x010f: 'Canon' });
    expect(readExifStrings(Buffer.from('garbage'))).toEqual({});
    const truncated = exif.subarray(0, 20);
    expect(() => readExifStrings(truncated)).not.toThrow();
  });

  it.skipIf(!hasFfmpeg)('reads prompt/workflow tags from MP4 (ComfyUI SaveVideo)', () => {
    const file = path.join(tmpDir(), 'v.mp4');
    makeVideo(file, { seconds: 1, metadata: { prompt: fixture('wan-video.prompt.json').replace(/\s+/g, ' '), workflow: '{"nodes":[]}' } });
    return extract(file, 'video', { ffprobe: FFPROBE }).then((x) => {
      expect(x.videoCodec).toBe('h264');
      expect(x.width).toBe(160);
      expect(x.duration).toBeCloseTo(1, 0);
      expect(x.summary?.params.frames).toBe(81);
      expect(x.workflowJson).toBe('{"nodes":[]}');
    });
  });

  it.skipIf(!hasFfmpeg)('reads VideoHelperSuite metadata stored in the comment tag', async () => {
    const file = path.join(tmpDir(), 'vhs.mp4');
    const prompt = JSON.parse(fixture('sdxl-basic.prompt.json'));
    makeVideo(file, { metadata: { comment: JSON.stringify({ prompt: JSON.stringify(prompt), workflow: { nodes: [] } }) } });
    const x = await extract(file, 'video', { ffprobe: FFPROBE });
    expect(x.summary?.params.seed).toBe(123456789);
    expect(x.extra.comment).toBeUndefined();
  });

  it('fails cleanly on corrupt media', async () => {
    const file = path.join(tmpDir(), 'corrupt.png');
    fs.writeFileSync(file, Buffer.from('\x89PNG\r\n\x1a\nthis is not really a png'));
    await expect(extract(file, 'image', { ffprobe: FFPROBE })).rejects.toThrow();
  });
});
