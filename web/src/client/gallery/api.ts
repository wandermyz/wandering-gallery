export interface Library {
  id: string;
  name: string;
  writable: boolean;
  recursive: boolean;
  showInAll: boolean;
  count: number;
  images: number;
  videos: number;
  available: boolean;
  error: string | null;
  scanning: boolean;
  lastScanMs: number | null;
}

export interface Asset {
  id: number;
  library: string;
  path: string;
  folder: string;
  name: string;
  kind: 'image' | 'video';
  mime: string;
  size: number;
  mtimeMs: number;
  width: number | null;
  height: number | null;
  duration: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  playable: 'yes' | 'partial' | 'no' | 'unknown';
  animated: boolean;
  hasMeta: boolean;
  indexState: 'pending' | 'done' | 'error';
  indexError: string | null;
  favorite: boolean;
  rating: number;
  status: 'ready' | 'missing' | 'trashed';
  trashedAtMs: number | null;
  /** Caption sidecar status ('unknown' for an unreadable json), null when there is no caption. */
  caption: CaptionStatus | 'unknown' | null;
  captionCandidate: boolean;
  /** Changes whenever the cached caption changes. */
  captionRev: number;
  v: string;
  needsPreview: boolean;
  libraryName?: string;
  writable?: boolean;
  expiresAtMs?: number;
}

export interface Folder {
  path: string;
  name: string;
  count: number;
  latestMs: number;
  cover: { id: number; v: string } | null;
}

export type Scalar = string | number | boolean;

export interface Summary {
  source: 'comfyui' | 'a1111' | 'unknown';
  positive: string[];
  negative: string[];
  otherText: string[];
  samplers: {
    nodeId: string; classType: string; title?: string; seed?: Scalar; steps?: Scalar; cfg?: Scalar;
    sampler?: Scalar; scheduler?: Scalar; denoise?: Scalar; positive?: string; negative?: string;
  }[];
  models: { kind: string; name: string; nodeId?: string }[];
  loras: { name: string; strengthModel?: number; strengthClip?: number }[];
  params: Record<string, Scalar>;
  nodeTypes: string[];
}

export interface MetadataResponse {
  indexState: string;
  indexError: string | null;
  summary: Summary | null;
  extra: Record<string, string>;
  parameters: string | null;
  hasPrompt: boolean;
  hasWorkflow: boolean;
  promptBytes: number;
  workflowBytes: number;
}

export type CaptionStatus = 'generated' | 'edited' | 'approved' | 'needs_regen';
export type CaptionFilter = 'any' | 'none' | CaptionStatus | 'candidate';

/** Parsed `<stem>.caption.json` (see wandering-lora docs/sidecar-format.md); unknown keys pass through. */
export interface CaptionJson {
  status?: string;
  caption?: string;
  description?: string;
  classification?: Record<string, unknown>;
  raw?: { output?: string; dropped_tags?: string[] } & Record<string, unknown>;
  generation?: { model?: string; revision?: string; created_at?: string; pipeline_version?: string } & Record<string, unknown>;
  candidate?: { caption?: string; description?: string; classification?: Record<string, unknown>; generation?: { model?: string; created_at?: string } } | null;
  updated_at?: string;
  [k: string]: unknown;
}

export interface CaptionResponse {
  txt: string | null;
  json: CaptionJson | null;
  jsonError: string | null;
  status: CaptionStatus | null;
  updated_at: string | null;
  txt_sha256: string | null;
  json_sha256: string | null;
  writable: boolean;
}

export type CaptionAction = 'save' | 'approve' | 'needs_regen' | 'accept_candidate' | 'discard_candidate';

export interface Dataset {
  name: string;
  count: number;
}

export type DatasetMode = 'move' | 'copy';
/** When the name is taken: ask (the server answers 409 with `conflict`), replace, or keep both. */
export type DatasetConflict = 'ask' | 'replace' | 'rename';

export interface DatasetResult {
  mode: DatasetMode;
  dataset: string;
  created: boolean;
  /** File name in the dataset. */
  name: string;
  /** An existing file of that name was replaced (it went to the trash). */
  replaced: boolean;
  /** After a move into a folder that is a library: the asset at its new place. */
  asset: Asset | null;
}

export interface Page {
  items: Asset[];
  next: string | null;
  total?: number;
}

export interface Query {
  library?: string;
  folder?: string;
  recursive?: boolean;
  favorite?: boolean;
  minRating?: number;
  kind?: 'image' | 'video';
  caption?: CaptionFilter;
  order?: 'asc' | 'desc';
}

export class ApiError extends Error {
  /** `data` is the whole JSON error body (extra details some endpoints send). */
  constructor(message: string, readonly status: number, readonly data: Record<string, unknown> = {}) {
    super(message);
  }
}

let csrf: string | null = null;

async function session(): Promise<string> {
  if (csrf) return csrf;
  const r = await fetch('/api/session', { cache: 'no-store' });
  csrf = ((await r.json()) as { csrf: string }).csrf;
  return csrf;
}

export async function request<T>(method: string, url: string, body?: unknown, retried = false): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== 'GET') {
    headers['X-CSRF-Token'] = await session();
    headers['Content-Type'] = 'application/json';
  }
  let r: Response;
  try {
    r = await fetch(url, { method, headers, body: body === undefined ? (method !== 'GET' ? '{}' : undefined) : JSON.stringify(body) });
  } catch {
    throw new ApiError('Network error. Check your connection.', 0);
  }
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    let data: Record<string, unknown> = {};
    try {
      data = (await r.json()) as Record<string, unknown>;
      if (typeof data.error === 'string') msg = data.error;
    } catch {
      /* not json */
    }
    // The server restarted and rotated its token: fetch a new one and retry once.
    if (r.status === 403 && /csrf/i.test(msg) && !retried) {
      csrf = null;
      return request<T>(method, url, body, true);
    }
    throw new ApiError(msg, r.status, data);
  }
  return (await r.json()) as T;
}

function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    u.set(k, v === true ? '1' : String(v));
  }
  const s = u.toString();
  return s ? `?${s}` : '';
}

export const api = {
  libraries: () => request<{ libraries: Library[] }>('GET', '/api/libraries'),
  status: () => request<{ pending: number; scanning: boolean; current: string | null; trash: number; trashRetentionDays: number }>('GET', '/api/status'),
  folders: (library: string, folder: string) => request<{ folders: Folder[] }>('GET', `/api/folders${qs({ library, folder })}`),
  assets: (q: Query, cursor?: string | null, limit = 120) =>
    request<Page>('GET', `/api/assets${qs({
      library: q.library, folder: q.folder, recursive: q.recursive === false ? '0' : undefined,
      favorite: q.favorite, minRating: q.minRating || undefined, kind: q.kind, caption: q.caption, order: q.order === 'asc' ? 'asc' : undefined,
      cursor, limit,
    })}`),
  asset: (id: number) => request<Asset>('GET', `/api/assets/${id}`),
  metadata: (id: number) => request<MetadataResponse>('GET', `/api/assets/${id}/metadata`),
  raw: async (id: number, which: 'prompt' | 'workflow') => {
    const r = await fetch(`/api/assets/${id}/raw/${which}`);
    if (!r.ok) throw new ApiError('not available', r.status);
    return r.text();
  },
  caption: (id: number) => request<CaptionResponse>('GET', `/api/assets/${id}/caption`),
  /** `loaded` is the caption response the edit is based on (for the server's conflict check). */
  captionAction: (id: number, action: CaptionAction, loaded: CaptionResponse, extra: { caption?: string; approve?: boolean } = {}) =>
    request<CaptionResponse>('POST', `/api/assets/${id}/caption`, {
      action, ...extra, updated_at: loaded.updated_at, txt_sha256: loaded.txt_sha256, json_sha256: loaded.json_sha256,
    }),
  favorite: (id: number, favorite: boolean) => request<Asset>('POST', `/api/assets/${id}/favorite`, { favorite }),
  rate: (id: number, rating: number) => request<Asset>('POST', `/api/assets/${id}/rating`, { rating }),
  trash: (a: Asset) => request<Asset>('POST', `/api/assets/${a.id}/trash`, { size: a.size, mtimeMs: a.mtimeMs }),
  datasets: () => request<{ root: string; datasets: Dataset[] }>('GET', '/api/datasets'),
  addToDataset: (a: Asset, dataset: string, mode: DatasetMode, create: boolean, onConflict: DatasetConflict = 'ask') =>
    request<DatasetResult>('POST', `/api/assets/${a.id}/dataset`, { dataset, mode, create, onConflict, size: a.size, mtimeMs: a.mtimeMs }),
  trashList: () => request<{ retentionDays: number; items: Asset[] }>('GET', '/api/trash'),
  restore: (id: number) => request<Asset>('POST', `/api/trash/${id}/restore`),
  purge: (id: number) => request<{ ok: true }>('POST', `/api/trash/${id}/purge`),
  rescan: (library?: string) => request<{ ok: true }>('POST', '/api/rescan', library ? { library } : {}),
};

export const thumbUrl = (a: { id: number; v: string }) => `/api/assets/${a.id}/thumb?v=${a.v}`;
export const fileUrl = (a: { id: number; v: string }) => `/api/assets/${a.id}/file?v=${a.v}`;
export const displayUrl = (a: Asset) => (a.needsPreview ? `/api/assets/${a.id}/preview?v=${a.v}` : fileUrl(a));
