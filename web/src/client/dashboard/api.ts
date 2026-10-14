import { request } from '../gallery/api';

export interface DashJob {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  createdAtMs: number | null;
  /** Running jobs: estimated (when the job before it ended). */
  startedAtMs: number | null;
  endedAtMs: number | null;
  error: string | null;
  clientId: string | null;
  /** The save node's filename prefix. */
  title: string | null;
  model: string | null;
  /** The generate flow, for jobs queued from this app. */
  flow: string | null;
  /** Sampler progress 0..1, only for running jobs queued from this app. */
  progress: number | null;
  output: { filename: string; subfolder: string; type: string; asset: { id: number; v: string; library: string; width: number | null; height: number | null } | null } | null;
}

export interface GpuSample {
  atMs: number;
  name: string;
  util: number;
  memUsedMib: number;
  memTotalMib: number;
  tempC: number | null;
  powerW: number | null;
  powerLimitW: number | null;
}

export interface Workload {
  mode: string;
  strata: { service: boolean; reachable: boolean; loaded: boolean };
  comfy: { service: boolean; reachable: boolean; running: number; pending: number; holds_models: boolean };
  gpu: { total_mib: number | null; free_mib: number | null; strata_mib: number; comfy_mib: number; other_mib: number; error?: string };
  last_event: ({ time: string; event: string } & Record<string, unknown>) | null;
}

export interface Dashboard {
  atMs: number;
  comfy: { url: string; online: boolean; error: string | null; running: DashJob[]; pending: DashJob[]; recent: DashJob[] };
  gpu: { now: GpuSample | null; history: GpuSample[]; error: string | null };
  /** null when gpu-workload is not configured. */
  workload: { status: Workload | null; error: string | null } | null;
}

export const dashApi = {
  get: () => request<Dashboard>('GET', '/api/dashboard'),
  cancel: (id: string) => request<{ ok: true }>('POST', `/api/dashboard/jobs/${encodeURIComponent(id)}/cancel`),
};
