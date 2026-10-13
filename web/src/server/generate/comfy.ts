import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HttpError } from '../paths.js';

/** An API-format ComfyUI graph: node id → { class_type, inputs }. */
export type Graph = Record<string, { class_type: string; inputs: Record<string, unknown>; _meta?: unknown }>;

export interface OutputFile {
  filename: string;
  subfolder: string;
  type: string;
}

export interface JobResult {
  status: 'completed' | 'error' | 'cancelled';
  outputs: OutputFile[];
  error: string | null;
}

export interface Progress {
  node: string;
  value: number;
  max: number;
}

/** What the generate flows need from ComfyUI. Tests substitute a fake. */
export interface ComfyClient {
  /** Throws a 503 HttpError when ComfyUI is not reachable. */
  stats(): Promise<{ devices: { name: string; vramTotal: number; vramFree: number }[] }>;
  /** Queues a graph; `pnginfo` is embedded in saved images. Returns the prompt id. */
  submit(graph: Graph, pnginfo: Record<string, unknown>): Promise<string>;
  /** Waits for a queued job, reporting progress. `signal` stops waiting (it does not cancel the job). */
  watch(promptId: string, onProgress: (p: Progress) => void, signal: AbortSignal): Promise<JobResult>;
  cancel(promptId: string): Promise<void>;
  /** Copies a local file into ComfyUI's input folder as `name` (replacing one of that name). */
  upload(file: string, name: string): Promise<void>;
}

interface Envelope {
  type: 'envelope';
  ok: boolean;
  data: Record<string, unknown> | null;
  error: { code?: string; message?: string } | null;
}

const TERMINAL = new Set(['completed', 'error', 'cancelled']);
const NOT_RUNNING = new Set(['server_not_running', 'connection_refused']);

/**
 * Drives ComfyUI through comfy-cli (`jobs status|watch|cancel`, `system-stats`)
 * with JSON output. Only `submit` talks to ComfyUI directly: `comfy-cli run` cannot attach
 * `extra_pnginfo`, which carries the UI workflow and source prompt into the PNG.
 */
export class CliComfyClient implements ComfyClient {
  private readonly clientId = `wandering-gallery-${crypto.randomUUID()}`;

  constructor(private readonly url: string, private readonly cli: string) {}

  private notRunning(): HttpError {
    return new HttpError(`ComfyUI is not running at ${this.url}. Start it and try again.`, 503, { code: 'comfyui_down' });
  }

  /** Runs comfy-cli and returns its final JSON envelope; other NDJSON lines go to `onEvent`. */
  private cli_(args: string[], opts: { timeoutMs?: number; onEvent?: (ev: Record<string, unknown>) => void; signal?: AbortSignal } = {}): Promise<Envelope> {
    const { timeoutMs = 60_000, onEvent, signal } = opts;
    return new Promise((resolve, reject) => {
      const child = spawn(this.cli, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        // COMFY_LOCAL_URL points every subcommand at the configured server.
        env: { ...process.env, COMFY_LOCAL_URL: this.url, COMFY_NO_WATCH: '1' },
      });
      let envelope: Envelope | null = null;
      let buf = '';
      let err = '';
      let stopped: string | null = null;
      const stop = (why: string) => {
        stopped = why;
        child.kill('SIGTERM');
      };
      const timer = setTimeout(() => stop('timed out'), timeoutMs);
      const onAbort = () => stop('aborted');
      signal?.addEventListener('abort', onAbort, { once: true });
      const line = (l: string) => {
        if (!l.trim()) return;
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(l) as Record<string, unknown>;
        } catch {
          return;
        }
        if (ev.type === 'envelope') envelope = ev as unknown as Envelope;
        else onEvent?.(ev);
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d: string) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          line(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      });
      child.stderr.on('data', (d: Buffer) => {
        if (err.length < 4096) err += d.toString();
      });
      child.on('error', (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(e.code === 'ENOENT' ? new HttpError(`comfy-cli not found ("${this.cli}"); set generate.comfyCli in the config`, 500) : e);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        line(buf);
        if (stopped) return reject(new Error(`comfy-cli ${args[0]} ${stopped}`));
        if (envelope) return resolve(envelope);
        reject(new Error(`comfy-cli ${args.join(' ')} exited with ${code}: ${err.trim().split('\n').pop() ?? ''}`));
      });
    });
  }

  /** Data of a successful envelope; maps comfy-cli errors to HTTP errors. */
  private data(env: Envelope): Record<string, unknown> {
    if (env.ok && env.data) return env.data;
    if (env.error?.code && NOT_RUNNING.has(env.error.code)) throw this.notRunning();
    throw new HttpError(`ComfyUI: ${env.error?.message ?? 'unknown error'}`, 502);
  }

  async stats() {
    const d = this.data(await this.cli_(['--json', 'system-stats']));
    const devices = (d.devices as { name: string; vram_total: number; vram_free: number }[] | undefined) ?? [];
    return { devices: devices.map((x) => ({ name: x.name, vramTotal: x.vram_total, vramFree: x.vram_free })) };
  }

  async submit(graph: Graph, pnginfo: Record<string, unknown>) {
    let r: Response;
    try {
      r = await fetch(`${this.url}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Our own client id, so `jobs watch` can attach to this job's live events.
        body: JSON.stringify({ prompt: graph, client_id: this.clientId, extra_data: { extra_pnginfo: pnginfo } }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw this.notRunning();
    }
    const body = (await r.json().catch(() => ({}))) as { prompt_id?: string; error?: { message?: string; details?: string } | string; node_errors?: Record<string, { errors?: { details?: string }[] }> };
    if (!r.ok || !body.prompt_id) {
      const e = typeof body.error === 'string' ? body.error : [body.error?.message, body.error?.details].filter(Boolean).join(': ');
      const nodes = Object.entries(body.node_errors ?? {}).map(([id, n]) => `node ${id}: ${n.errors?.map((x) => x.details).join(', ')}`);
      throw new HttpError(`ComfyUI rejected the workflow: ${[e || `HTTP ${r.status}`, ...nodes].join('; ')}`, 502);
    }
    return body.prompt_id;
  }

  async watch(promptId: string, onProgress: (p: Progress) => void, signal: AbortSignal): Promise<JobResult> {
    const onEvent = (ev: Record<string, unknown>) => {
      if (ev.type === 'progress' && typeof ev.completed === 'number' && typeof ev.total === 'number') {
        onProgress({ node: String(ev.node), value: ev.completed, max: ev.total });
      }
    };
    // `jobs watch` gives up after --timeout seconds without events (e.g. a long queue
    // ahead); keep watching until the job ends.
    for (;;) {
      let env: Envelope | null = null;
      try {
        env = await this.cli_(['--json-stream', 'jobs', 'watch', promptId, '--client-id', this.clientId, '--timeout', '300'], { timeoutMs: 24 * 3600_000, onEvent, signal });
      } catch (e) {
        if (signal.aborted) throw e;
      }
      let st = jobSnapshot(env);
      if (!TERMINAL.has(String(st?.status))) {
        // Watch ended without a verdict (silence timeout, nothing streamed): ask directly.
        const status = await this.cli_(['--json', 'jobs', 'status', promptId]);
        st = jobSnapshot(status);
        if (!st) this.data(status); // throws: ComfyUI down or job unknown
      }
      if (st && TERMINAL.has(String(st.status))) {
        const outputs = ((st.outputs as string[] | undefined) ?? []).map(parseOutputUrl).filter((o): o is OutputFile => !!o);
        const status = st.status as JobResult['status'];
        return { status, outputs, error: status === 'error' ? st.message || 'ComfyUI reported an error' : null };
      }
      if (signal.aborted) throw new Error('aborted');
    }
  }

  async cancel(promptId: string) {
    this.data(await this.cli_(['--json', 'jobs', 'cancel', promptId]));
  }

  async upload(file: string, name: string) {
    // comfy-cli uploads under the file's own name: link it into a scratch folder as `name`.
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'wandering-gallery-'));
    try {
      const staged = path.join(dir, name);
      await fs.promises.link(file, staged).catch(() => fs.promises.copyFile(file, staged));
      this.data(await this.cli_(['--json', 'upload', '--overwrite', staged], { timeoutMs: 5 * 60_000 }));
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  }
}

/**
 * The job record in a `jobs watch|status` envelope. Failed and cancelled jobs come
 * back as ok:false with the record under error.details; `message` is the cause.
 */
function jobSnapshot(env: Envelope | null): (Record<string, unknown> & { message?: string }) | null {
  if (!env) return null;
  if (env.ok) return env.data;
  const details = (env.error as { details?: Record<string, unknown> } | null)?.details;
  if (details && typeof details.status === 'string') return { ...details, message: env.error?.message };
  return null;
}

/** `http://host/view?filename=a.png&subfolder=x&type=output` → its parts. */
export function parseOutputUrl(u: string): OutputFile | null {
  try {
    const q = new URL(u).searchParams;
    const filename = q.get('filename');
    if (!filename) return null;
    return { filename, subfolder: q.get('subfolder') ?? '', type: q.get('type') ?? 'output' };
  } catch {
    return null;
  }
}
