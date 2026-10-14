import { request, type Asset } from '../gallery/api';

export interface FlowInfo {
  id: string;
  title: string;
  /** `tags`: description → tags → images. `typed`: typed tags, checked by search → images. `video`: image + prompt → video. */
  kind: 'tags' | 'typed' | 'video';
  ready: boolean;
  problem: string | null;
  promptsFile: string;
  /** Quality tags plus the LoRA's tags, prefilled into variation 1. */
  defaultTags: string;
  /** Video flows: the clip lengths offered, in seconds. */
  seconds?: number[];
  defaultSeconds?: number;
}

export interface ComfyStatus {
  url: string;
  online: boolean;
  error: string | null;
  devices: { name: string; vramTotal: number; vramFree: number }[];
}

/** A Danbooru tag found by a search. */
export interface TagHit {
  tag: string;
  /** As it goes into a prompt: spaces, brackets escaped. */
  prompt: string;
  category: string;
  posts: number;
  wiki: string | null;
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
  /** Video runs: the input image and the clip length. */
  video: { sourcePath: string; sourceAsset: number | null; seconds: number } | null;
}

export const genApi = {
  flows: () => request<{ flows: FlowInfo[] }>('GET', '/api/generate/flows'),
  status: () => request<ComfyStatus>('GET', '/api/generate/status'),
  tags: (flow: string, prompt: string, vary: boolean) => request<{ tags: string }>('POST', `/api/generate/flows/${flow}/tags`, { prompt, vary }),
  /** The k closest Danbooru tags for each query. */
  searchTags: (queries: string[], k = 5) => request<{ results: Record<string, TagHit[]> }>('POST', '/api/generate/tags/search', { queries, k }),
  start: (flow: string, prompt: string, variations: string[], batch: number) =>
    request<Run>('POST', `/api/generate/flows/${flow}/runs`, { prompt, variations, batch }),
  /** The gallery image at a path copied in the viewer. */
  videoImage: (path: string) => request<{ asset: Asset }>('POST', '/api/generate/video/image', { path }),
  startVideo: (flow: string, image: string, prompt: string, seconds: number, batch: number) =>
    request<Run>('POST', `/api/generate/flows/${flow}/runs`, { image, prompt, seconds, batch }),
  /** Runs still being worked on. */
  runs: () => request<{ runs: Run[] }>('GET', '/api/generate/runs'),
  run: (id: string) => request<Run>('GET', `/api/generate/runs/${id}`),
  cancel: (id: string) => request<Run>('POST', `/api/generate/runs/${id}/cancel`),
};
