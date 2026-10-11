import { request } from '../gallery/api';

export interface FlowInfo {
  id: string;
  title: string;
  ready: boolean;
  problem: string | null;
  promptsFile: string;
}

export interface ComfyStatus {
  url: string;
  online: boolean;
  error: string | null;
  devices: { name: string; vramTotal: number; vramFree: number }[];
}

export interface RunOutput {
  filename: string;
  subfolder: string;
  type: string;
  /** The gallery asset once the image is indexed. */
  asset: { id: number; v: string; library: string; width: number | null; height: number | null } | null;
}

export interface Job {
  variation: number;
  index: number;
  seed: number;
  promptId: string | null;
  status: 'pending' | 'queued' | 'running' | 'completed' | 'error' | 'cancelled';
  progress: number;
  error: string | null;
  outputs: RunOutput[];
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
}

export const genApi = {
  flows: () => request<{ flows: FlowInfo[] }>('GET', '/api/generate/flows'),
  status: () => request<ComfyStatus>('GET', '/api/generate/status'),
  tags: (flow: string, prompt: string, vary: boolean) => request<{ tags: string }>('POST', `/api/generate/flows/${flow}/tags`, { prompt, vary }),
  start: (flow: string, prompt: string, variations: string[], batch: number) =>
    request<Run>('POST', `/api/generate/flows/${flow}/runs`, { prompt, variations, batch }),
  /** Runs still being worked on. */
  runs: () => request<{ runs: Run[] }>('GET', '/api/generate/runs'),
  run: (id: string) => request<Run>('GET', `/api/generate/runs/${id}`),
  cancel: (id: string) => request<Run>('POST', `/api/generate/runs/${id}/cancel`),
};
