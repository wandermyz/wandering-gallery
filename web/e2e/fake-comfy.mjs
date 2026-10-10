// Stand-in ComfyUI for the browser tests: accepts /prompt, "runs" each job for about a
// second (writing a PNG into the output folder) and exposes the state the fake comfy-cli
// reads. POST /fake/online {"online": false} makes it behave as if it were stopped.
//   node e2e/fake-comfy.mjs <port> <outputDir>
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

async function work() {
  for (;;) {
    const job = queue.shift();
    if (!job) return;
    job.status = 'running';
    for (let s = 1; s <= 4 && job.status === 'running'; s++) {
      await new Promise((r) => setTimeout(r, 250));
      job.progress = s / 4;
    }
    if (job.status !== 'running') continue;
    const name = `fake_${String(++count).padStart(5, '0')}_.png`;
    fs.mkdirSync(outDir, { recursive: true });
    await sharp({ create: { width: 90, height: 160, channels: 3, background: `hsl(${count * 47}, 60%, 50%)` } }).png().toFile(path.join(outDir, name));
    job.outputs = [`http://127.0.0.1:${port}/view?filename=${name}&subfolder=&type=output`];
    job.status = 'completed';
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
    const job = { id, status: 'queued', progress: 0, outputs: [], graph: b.prompt, pnginfo: b.extra_data?.extra_pnginfo };
    jobs.set(id, job);
    queue.push(job);
    if (queue.length === 1 && ![...jobs.values()].some((j) => j.status === 'running')) void work();
    return send(200, { prompt_id: id });
  }
  if (url.pathname === '/fake/tags') {
    // The tagging graph: echo the description so tests can tell variations apart.
    const g = await body(req);
    const vary = g['11']?.inputs?.sampling_mode === 'on';
    await new Promise((r) => setTimeout(r, 300));
    return send(200, { text: `1girl, ${vary ? 'varied' : 'base'} tags for ${String(g['8'].inputs.value).split('\n')[0]}` });
  }
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
    return send(200, { status: job.status, progress: job.progress, outputs: job.outputs });
  }
  if (url.pathname === '/system_stats') return send(200, { devices: [{ name: 'Fake GPU : test', vram_total: 1, vram_free: 1 }] });
  send(404, { error: 'not found' });
}).listen(Number(port), '127.0.0.1');
