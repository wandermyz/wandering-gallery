// Stand-in ComfyUI for the browser tests: accepts /prompt, "runs" each job for about a
// second (writing a PNG into the output folder) and exposes the state the fake comfy-cli
// reads. POST /fake/online {"online": false} makes it behave as if it were stopped.
// Video jobs (a SaveVideo node) write a short MP4 under video/ with ffmpeg ($FFMPEG).
// $FAKE_COMFY_STEP_MS slows each of the four steps down (default 250).
//   node e2e/fake-comfy.mjs <port> <outputDir>
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import sharp from 'sharp';

const [port, outDir] = process.argv.slice(2);
const jobs = new Map(); // id -> { status, progress, outputs, graph }
const queue = [];
let online = true;
let n = 0;
let count = 0;
const stepMs = Number(process.env.FAKE_COMFY_STEP_MS) || 250;

async function work() {
  for (;;) {
    const job = queue.shift();
    if (!job) return;
    job.status = 'running';
    job.startedAt = Date.now();
    for (let s = 1; s <= 4 && job.status === 'running'; s++) {
      await new Promise((r) => setTimeout(r, stepMs));
      job.progress = s / 4;
    }
    if (job.status !== 'running') continue;
    const video = Object.values(job.graph ?? {}).some((n) => n.class_type === 'SaveVideo');
    // Don't overwrite outputs of an earlier run of the fake on the same folder.
    while (fs.existsSync(path.join(outDir, `fake_${String(count + 1).padStart(5, '0')}_.png`)) || fs.existsSync(path.join(outDir, 'video', `fake_${String(count + 1).padStart(5, '0')}_.mp4`))) count++;
    const name = `fake_${String(++count).padStart(5, '0')}_.${video ? 'mp4' : 'png'}`;
    const sub = video ? 'video' : '';
    fs.mkdirSync(path.join(outDir, sub), { recursive: true });
    if (video) {
      execFileSync(process.env.FFMPEG || 'ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x${(count * 0x2f4f6f).toString(16).padStart(6, '0').slice(-6)}:s=160x90:d=1`,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(outDir, sub, name)]);
    } else {
      await sharp({ create: { width: 90, height: 160, channels: 3, background: `hsl(${count * 47}, 60%, 50%)` } }).png().toFile(path.join(outDir, name));
    }
    job.outputs = [`http://127.0.0.1:${port}/view?filename=${name}&subfolder=${sub}&type=output`];
    job.status = 'completed';
    job.endedAt = Date.now();
  }
}

const body = (req) => new Promise((resolve) => {
  let s = '';
  req.on('data', (d) => (s += d));
  req.on('end', () => resolve(s ? JSON.parse(s) : {}));
});

http.createServer(async (req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/fake/online') {
    online = (await body(req)).online !== false;
    return send(200, { online });
  }
  if (!online) return send(503, { error: 'offline' });
  if (url.pathname === '/prompt' && req.method === 'POST') {
    const b = await body(req);
    const id = `fake-${++n}`;
    const job = { id, number: n, createdAt: Date.now(), status: 'queued', progress: 0, outputs: [], graph: b.prompt, pnginfo: b.extra_data?.extra_pnginfo };
    jobs.set(id, job);
    queue.push(job);
    if (queue.length === 1 && ![...jobs.values()].some((j) => j.status === 'running')) void work();
    return send(200, { prompt_id: id });
  }
  if (url.pathname === '/fake/upload' && req.method === 'POST') {
    const inDir = path.join(outDir, '..', 'comfy-in');
    fs.mkdirSync(inDir, { recursive: true });
    const { files } = await body(req);
    for (const f of files) fs.copyFileSync(f, path.join(inDir, path.basename(f)));
    return send(200, { uploads: files.map((f) => ({ local_path: f, cloud_name: path.basename(f), subfolder: '', type: 'input' })) });
  }
  if (url.pathname === '/fake/inputs') return send(200, { files: fs.existsSync(path.join(outDir, '..', 'comfy-in')) ? fs.readdirSync(path.join(outDir, '..', 'comfy-in')) : [] });
  const m = url.pathname.match(/^\/fake\/jobs\/(.+)$/);
  if (m) {
    const job = jobs.get(m[1]);
    if (!job) return send(404, { error: 'not found' });
    if (req.method === 'DELETE') {
      if (job.status === 'queued' || job.status === 'running') job.status = 'cancelled';
      const i = queue.indexOf(job);
      if (i >= 0) queue.splice(i, 1);
      return send(200, {});
    }
    return send(200, { status: job.status, progress: job.progress, outputs: job.outputs, graph: job.graph });
  }
  // What the dashboard reads: /queue (running and pending, with graphs) and /api/jobs (history).
  if (url.pathname === '/queue') {
    const item = (j) => [j.number, j.id, j.graph, { client_id: 'wandering-gallery-fake', create_time: j.createdAt }, []];
    const all = [...jobs.values()];
    return send(200, { queue_running: all.filter((j) => j.status === 'running').map(item), queue_pending: all.filter((j) => j.status === 'queued').map(item) });
  }
  if (url.pathname === '/api/jobs') {
    const done = [...jobs.values()].filter((j) => ['completed', 'error', 'cancelled'].includes(j.status)).reverse();
    return send(200, {
      jobs: done.map((j) => {
        const o = j.outputs[0] && new URL(j.outputs[0]).searchParams;
        return {
          id: j.id, status: j.status === 'error' ? 'failed' : j.status, create_time: j.createdAt, execution_start_time: j.startedAt, execution_end_time: j.endedAt,
          ...(o ? { preview_output: { filename: o.get('filename'), subfolder: o.get('subfolder'), type: 'output' } } : {}),
        };
      }),
    });
  }
  if (url.pathname === '/system_stats') return send(200, { devices: [{ name: 'Fake GPU : test', vram_total: 1, vram_free: 1 }] });
  send(404, { error: 'not found' });
}).listen(Number(port), '127.0.0.1');
