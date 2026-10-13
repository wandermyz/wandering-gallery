import crypto from 'node:crypto';
import type { Db } from '../db.js';
import { HttpError } from '../paths.js';
import type { ComfyClient, Graph, OutputFile, Progress } from './comfy.js';
import { randomSeed } from './flow.js';
import type { Gpu } from './tools.js';

export type JobStatus = 'pending' | 'queued' | 'running' | 'completed' | 'error' | 'cancelled';

export interface Job {
  variation: number;
  index: number;
  seed: number;
  promptId: string | null;
  status: JobStatus;
  /** Sampler progress 0..1 while running. */
  progress: number;
  error: string | null;
  outputs: OutputFile[];
}

export interface Run {
  id: string;
  flow: string;
  createdAtMs: number;
  finishedAtMs: number | null;
  prompt: string;
  variations: string[];
  batch: number;
  jobs: Job[];
  status: 'running' | 'completed' | 'error' | 'cancelled';
  /** Video runs: the input image and the clip length. */
  video: { sourcePath: string; sourceAsset: number | null; seconds: number } | null;
}

/** What a run's jobs are built from: a flow, or a flow bound to one request's input. */
export interface JobSource {
  id: string;
  /** Throws when the flow cannot run (missing files), before the GPU is touched. */
  check(): void;
  job(prompt: string, text: string, seed: number): { graph: Graph; pnginfo: Record<string, unknown> };
}

/** A finished run stays fetchable by id this long, so an open page sees its final state. */
const FINISHED_TTL_MS = 10 * 60_000;
export const MAX_VARIATIONS = 12;
export const MAX_BATCH = 16;
/** Videos take minutes each. */
export const MAX_VIDEO_BATCH = 4;

/**
 * Tracks the runs being worked on, in memory only. All jobs of a run are queued at
 * once (ComfyUI runs them in order) and then watched one at a time with comfy-cli.
 * Finished runs are forgotten: they drop out of `list()` at once and out of `get()`
 * after FINISHED_TTL_MS. The images are in the gallery.
 */
export class Runs {
  private readonly runs = new Map<string, Run>();
  private readonly aborts = new Map<string, AbortController>();

  constructor(private readonly comfy: ComfyClient, private readonly gpu: Gpu, private readonly db: Db, private readonly outputLibrary: string | null,
    private readonly log: { warn: (o: object, msg: string) => void } = { warn() {} }) {}

  /** Runs still being worked on, newest first. */
  list(): Run[] {
    return [...this.runs.values()].filter((r) => r.status === 'running').sort((a, b) => b.createdAtMs - a.createdAtMs);
  }

  get(id: string): Run {
    const r = this.runs.get(id);
    if (!r) throw new HttpError('run not found', 404);
    return r;
  }

  /**
   * Validates, hands the GPU to ComfyUI, queues every job and starts watching. Resolves
   * once all jobs are queued.
   */
  async start(flow: JobSource, prompt: string, variations: string[], batch: number, video: Run['video'] = null): Promise<Run> {
    flow.check();
    await this.gpu.toComfy();
    const run: Run = {
      id: crypto.randomBytes(6).toString('hex'),
      flow: flow.id,
      createdAtMs: Date.now(),
      finishedAtMs: null,
      prompt,
      variations,
      batch,
      jobs: variations.flatMap((_, v) => Array.from({ length: batch }, (_, i): Job => ({
        variation: v, index: i, seed: randomSeed(), promptId: null, status: 'pending', progress: 0, error: null, outputs: [],
      }))),
      status: 'running',
      video,
    };
    for (const job of run.jobs) {
      const { graph, pnginfo } = flow.job(prompt, variations[job.variation], job.seed);
      try {
        job.promptId = await this.comfy.submit(graph, pnginfo);
        job.status = 'queued';
      } catch (e) {
        if (run.jobs[0] === job) throw e; // nothing queued: report it as the request's error
        job.status = 'error';
        job.error = (e as Error).message;
      }
    }
    this.runs.set(run.id, run);
    void this.watch(run);
    return run;
  }

  private async watch(run: Run) {
    const ac = new AbortController();
    this.aborts.set(run.id, ac);
    try {
      for (const job of run.jobs) {
        if (job.status !== 'queued' || ac.signal.aborted) continue;
        const onProgress = (p: Progress) => {
          job.status = 'running';
          // Only the sampler's steps are worth showing; other nodes report 0/1 → 1/1.
          if (p.max > 1) job.progress = Math.min(1, p.value / p.max);
        };
        try {
          const r = await this.comfy.watch(job.promptId!, onProgress, ac.signal);
          job.status = r.status;
          job.error = r.error;
          job.outputs = r.outputs.filter((o) => o.type === 'output');
          if (r.status === 'completed') job.progress = 1;
        } catch (e) {
          if (ac.signal.aborted) break;
          job.status = 'error';
          job.error = (e as Error).message;
          this.log.warn({ run: run.id, promptId: job.promptId, err: job.error }, 'generate job failed');
        }
      }
    } finally {
      this.aborts.delete(run.id);
      if (run.status === 'running') this.finish(run);
    }
  }

  private finish(run: Run, status?: Run['status']) {
    run.status = status ?? (run.jobs.every((j) => j.status === 'completed') ? 'completed'
      : run.jobs.some((j) => j.status === 'error') ? 'error' : run.jobs.some((j) => j.status === 'cancelled') ? 'cancelled' : 'completed');
    run.finishedAtMs = Date.now();
    setTimeout(() => this.runs.delete(run.id), FINISHED_TTL_MS).unref();
  }

  /** Cancels every job that has not finished. */
  async cancel(id: string): Promise<Run> {
    const run = this.get(id);
    if (run.status !== 'running') return run;
    this.aborts.get(id)?.abort();
    const open = run.jobs.filter((j) => j.status === 'queued' || j.status === 'running' || j.status === 'pending');
    // Pending first, then the running one, so ComfyUI does not start the next job meanwhile.
    open.sort((a, b) => (a.status === 'running' ? 1 : 0) - (b.status === 'running' ? 1 : 0));
    let failure: Error | null = null;
    for (const job of open) {
      if (job.promptId) {
        try {
          await this.comfy.cancel(job.promptId);
        } catch (e) {
          failure ??= e as Error;
        }
      }
      job.status = 'cancelled';
    }
    this.finish(run, 'cancelled');
    if (failure) throw failure;
    return run;
  }

  /** Stops watching (server shutdown). Jobs keep running in ComfyUI. */
  close() {
    for (const ac of this.aborts.values()) ac.abort();
  }

  /** Public shape: outputs resolved to gallery assets when they are indexed. */
  json(run: Run) {
    return {
      ...run,
      jobs: run.jobs.map((j) => ({ ...j, outputs: j.outputs.map((o) => ({ ...o, asset: this.asset(o) })) })),
    };
  }

  private asset(o: OutputFile): { id: number; v: string; library: string; width: number | null; height: number | null } | null {
    if (!this.outputLibrary) return null;
    const row = this.db.liveAt(this.outputLibrary, o.subfolder ? `${o.subfolder}/${o.filename}` : o.filename);
    return row ? { id: row.id, v: row.fingerprint.slice(0, 12), library: row.library_id, width: row.width, height: row.height } : null;
  }
}
