import { run } from '../proc.js';

/** One nvidia-smi reading of the card. */
export interface GpuSample {
  atMs: number;
  name: string;
  /** Percent. */
  util: number;
  memUsedMib: number;
  memTotalMib: number;
  tempC: number | null;
  powerW: number | null;
  powerLimitW: number | null;
}

/** `gpu-workload status --json`: who holds the GPU (see that tool's docstring). */
export interface Workload {
  mode: 'strata' | 'comfy' | 'conflict' | string;
  strata: { service: boolean; reachable: boolean; loaded: boolean };
  comfy: { service: boolean; reachable: boolean; running: number; pending: number; holds_models: boolean };
  gpu: { total_mib: number | null; free_mib: number | null; strata_mib: number; comfy_mib: number; other_mib: number; error?: string };
  last_event: ({ time: string; event: string } & Record<string, unknown>) | null;
}

/** Reads the GPU's state. Only ever observes: it never switches the workload. Tests substitute a fake. */
export interface GpuMonitor {
  /** The latest card reading and the ones before it (oldest first), or an error. */
  card(): Promise<{ now: GpuSample | null; history: GpuSample[]; error: string | null }>;
  /** null when gpu-workload is not configured. */
  workload(): Promise<{ status: Workload | null; error: string | null } | null>;
  close?(): void;
}

const SAMPLE_MS = 5_000;
/** Keep sampling this long after the last dashboard request. */
const IDLE_STOP_MS = 15 * 60_000;
const HISTORY = (15 * 60_000) / SAMPLE_MS;
const FIELDS = 'name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit';

const numOrNull = (s: string | undefined) => {
  const n = Number(s);
  return s === undefined || s.trim() === '' || !Number.isFinite(n) ? null : n;
};

export function parseNvidiaSmi(line: string, atMs: number): GpuSample | null {
  const p = line.split(',').map((x) => x.trim());
  if (p.length < 7) return null;
  return {
    atMs, name: p[0], util: numOrNull(p[1]) ?? 0, memUsedMib: numOrNull(p[2]) ?? 0, memTotalMib: numOrNull(p[3]) ?? 0,
    tempC: numOrNull(p[4]), powerW: numOrNull(p[5]), powerLimitW: numOrNull(p[6]),
  };
}

/**
 * nvidia-smi for the card, sampled every few seconds while someone has the dashboard
 * open (so it can draw the last minutes), and `gpu-workload status` on request.
 */
export class CliGpuMonitor implements GpuMonitor {
  private readonly samples: GpuSample[] = [];
  private lastError: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastAsked = 0;
  private inflight: Promise<void> | null = null;
  private workloadCache: { atMs: number; p: Promise<{ status: Workload | null; error: string | null }> } | null = null;

  constructor(private readonly nvidiaSmi: string, private readonly gpuWorkload: string | null) {}

  private sample(): Promise<void> {
    this.inflight ??= (async () => {
      try {
        const out = (await run(this.nvidiaSmi, [`--query-gpu=${FIELDS}`, '--format=csv,noheader,nounits'], { timeoutMs: 10_000, maxBytes: 64 * 1024 })).stdout.toString();
        const s = parseNvidiaSmi(out.split('\n')[0] ?? '', Date.now());
        if (!s) throw new Error(`nvidia-smi: unexpected output "${out.trim().slice(0, 100)}"`);
        this.samples.push(s);
        if (this.samples.length > HISTORY) this.samples.splice(0, this.samples.length - HISTORY);
        this.lastError = null;
      } catch (e) {
        this.lastError = (e as NodeJS.ErrnoException).code === 'ENOENT' ? `nvidia-smi not found ("${this.nvidiaSmi}"); set tools.nvidiaSmi in the config` : (e as Error).message;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  async card() {
    this.lastAsked = Date.now();
    const latest = this.samples.at(-1);
    if (!this.timer) {
      // Readings from before a gap would draw a misleading line across it.
      this.samples.length = 0;
      this.timer = setInterval(() => {
        if (Date.now() - this.lastAsked > IDLE_STOP_MS) return this.close();
        void this.sample();
      }, SAMPLE_MS).unref();
    }
    if (!latest || Date.now() - latest.atMs > SAMPLE_MS || this.lastError) await this.sample();
    return { now: this.lastError ? null : this.samples.at(-1) ?? null, history: [...this.samples], error: this.lastError };
  }

  async workload() {
    if (!this.gpuWorkload) return null;
    const cli = this.gpuWorkload;
    // `status` only probes (systemd, HTTP, nvidia-smi); several open pages share one.
    if (!this.workloadCache || Date.now() - this.workloadCache.atMs > 2_000) {
      this.workloadCache = {
        atMs: Date.now(),
        p: (async () => {
          try {
            const out = (await run(cli, ['status', '--json'], { timeoutMs: 20_000, maxBytes: 256 * 1024 })).stdout.toString();
            return { status: JSON.parse(out.trim().split('\n').pop() ?? '') as Workload, error: null };
          } catch (e) {
            const err = e as NodeJS.ErrnoException;
            return { status: null, error: err.code === 'ENOENT' ? `gpu-workload not found ("${cli}"); set generate.gpuWorkload in the config` : err.message };
          }
        })(),
      };
    }
    return this.workloadCache.p;
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
