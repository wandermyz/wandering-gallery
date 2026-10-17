import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { FFMPEG, FFPROBE, ageAll, fixture, hasFfmpeg, makeAudio, makeJpeg, makePng, makeVideo } from '../test/helpers.js';
import { hashPassphrase } from '../src/server/unlock.js';

/** Builds a throwaway library with a mix of media for the browser tests. */
async function setup() {
  const root = path.resolve('.tmp/e2e');
  fs.rmSync(root, { recursive: true, force: true });
  const lib = path.join(root, 'lib');
  const ro = path.join(root, 'readonly');
  fs.mkdirSync(lib, { recursive: true });
  fs.mkdirSync(ro, { recursive: true });

  await makePng(path.join(lib, 'gen_00001_.png'), {
    w: 832, h: 1216, color: '#3a4a8a',
    text: { prompt: fixture('controlnet-lora.prompt.json'), workflow: fixture('sdxl-basic.workflow.json') },
  });
  for (let i = 2; i <= 40; i++) {
    await makePng(path.join(lib, `gen_${String(i).padStart(5, '0')}_.png`), {
      w: 512, h: 768, color: `hsl(${i * 9}, 60%, 45%)`,
      text: { prompt: fixture('sdxl-basic.prompt.json') },
    });
  }
  await makeJpeg(path.join(lib, 'portraits', 'p1.jpg'), '#884422');
  await makeJpeg(path.join(lib, 'portraits', 'p2.jpg'), '#448822');
  // Caption sidecars as written by wandering-lora.
  fs.writeFileSync(path.join(lib, 'portraits', 'p1.txt'), 'portrait, man, smiling');
  fs.writeFileSync(path.join(lib, 'portraits', 'p1.caption.json'), JSON.stringify({
    schema: 'wandering-lora/caption@1', image: 'p1.jpg', status: 'generated',
    caption_sha256: crypto.createHash('sha256').update('portrait, man, smiling').digest('hex'),
    caption: 'portrait, man, smiling', description: 'A smiling man.', classification: { view: 'front', face_visible: true },
    raw: { output: 'portrait, man, smiling' }, generation: { model: 'Qwen/Qwen3.5-4B', created_at: '2026-10-10T05:30:00Z' },
    candidate: { caption: 'portrait, man, smiling, beard' }, previous: null, updated_at: '2026-10-10T05:30:00Z',
  }, null, 2));
  if (hasFfmpeg) makeVideo(path.join(lib, 'video', 'clip_00001_.mp4'), { seconds: 3, metadata: { prompt: fixture('wan-video.prompt.json').replace(/\s+/g, ' ') } });
  if (hasFfmpeg) makeAudio(path.join(lib, 'audio', 'tune_00001_.flac'), { seconds: 4 });
  // A Markdown document embedding an image, a video and an image that gets hidden.
  await makePng(path.join(lib, 'story', 'scene.png'), { w: 600, h: 900, color: '#6a4cc0' });
  await makePng(path.join(lib, 'story', 'secret.png'), { w: 400, h: 400, color: '#c04c6a' });
  if (hasFfmpeg) makeVideo(path.join(lib, 'story', 'scene.mp4'), { seconds: 2 });
  fs.writeFileSync(path.join(lib, 'story', 'tale.md'), [
    '# The Tale', '', 'Once upon a time, by the sea.', '', '![The scene](scene.png)', '',
    ...Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1}. The waves rolled in and out, again and again.\n`),
    '<video src="scene.mp4"></video>', '', '![](secret.png)', '', 'See [the scene](scene.png). The end.', '',
    '```mermaid', 'flowchart LR', '  Dawn --> Dusk', '```', '', '```mermaid', 'not a diagram', '```', '',
  ].join('\n'));
  await makePng(path.join(ro, 'locked.png'), { color: '#777777' });
  // Generate: output folder of the fake ComfyUI (a library hidden from All media) and the
  // local prompts file.
  fs.mkdirSync(path.join(root, 'comfy-out'), { recursive: true });
  fs.mkdirSync(path.join(root, 'prompts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'prompts', 'wai-illustrious-tags.yaml'), `
variationInstruction: Make a distinct character.
traits:
  - [red hair, blue hair]
qualityTags: masterpiece
negativePrompt: worst quality
`);

  ageAll(root, 3600);
  // Distinct mtimes so ordering is deterministic: gen_00001_ is the newest.
  const files = fs.readdirSync(lib).filter((f) => f.endsWith('.png')).sort().reverse();
  files.forEach((f, i) => {
    const t = new Date(Date.now() - 3600_000 - i * 60_000);
    fs.utimesSync(path.join(lib, f), t, t);
  });
  const newest = new Date(Date.now() - 600_000);
  fs.utimesSync(path.join(lib, 'gen_00001_.png'), newest, newest);
  if (hasFfmpeg) {
    const t = new Date(Date.now() - 300_000);
    fs.utimesSync(path.join(lib, 'video', 'clip_00001_.mp4'), t, t);
  }

  fs.writeFileSync(path.join(root, 'config.yaml'), `
server:
  port: 2398
dataDir: ./data
cacheDir: ./cache
scan:
  stableSeconds: 1
generate:
  comfyui: http://127.0.0.1:2397
  comfyCli: ${path.resolve('e2e/fake-comfy-cli.mjs')}
  tagger: ${path.resolve('e2e/fake-danbooru-tagger.mjs')}
  gpuWorkload: ${path.resolve('e2e/fake-vhotseat.mjs')}
  outputLibrary: comfy
  promptsDir: ./prompts
  loras:
    - id: mycat
      title: My cat LoRA
      lora: mycat.safetensors
      tags: mycat, cat
      negative: realistic
hidden:
  passphraseHash: ${await hashPassphrase('e2e passphrase')}
tools:
  ffmpeg: ${FFMPEG}
  ffprobe: ${FFPROBE}
  nvidiaSmi: ${path.resolve('e2e/fake-nvidia-smi.mjs')}
libraries:
  - id: lib
    name: Test Library
    path: ./lib
    writable: true
  - id: ro
    name: Read Only
    path: ./readonly
    writable: false
  - id: comfy
    name: Comfy Output
    path: ./comfy-out
    writable: false
    showInAll: false
`);
}

await setup();
