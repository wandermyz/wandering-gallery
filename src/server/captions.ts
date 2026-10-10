import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AssetRow, Db } from './db.js';
import type { Indexer } from './indexer.js';
import { sidecarNames } from './media.js';
import { HttpError, isInside } from './paths.js';

/**
 * Caption sidecars, as defined by wandering-lora's docs/sidecar-format.md:
 * `<stem>.txt` holds the training caption, `<stem>.caption.json` everything else.
 * The files are the source of truth; the `captions` table is only a cache.
 */

export const CAPTION_STATUSES = ['generated', 'edited', 'approved', 'needs_regen'] as const;
export type CaptionStatus = (typeof CAPTION_STATUSES)[number];
export const CAPTION_SCHEMA = 'wandering-lora/caption@1';

/** Sidecars larger than this are not read (a caption json is a few KB). */
const MAX_SIDECAR_BYTES = 4 * 1024 * 1024;

export type CaptionJson = Record<string, unknown> & {
  status?: unknown;
  caption_sha256?: unknown;
  updated_at?: unknown;
  candidate?: unknown;
  classification?: unknown;
};

export interface SidecarState {
  txt: string | null;
  txtSha256: string | null;
  json: CaptionJson | null;
  jsonSha256: string | null;
  jsonError: string | null;
}

export const sha256 = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');

/** Change signature of a file (null if absent); an atomic rename always changes the inode. */
export function sigOf(st: { size: number; mtimeMs: number; ino: number } | null): string | null {
  return st ? `${st.size}:${Math.floor(st.mtimeMs)}:${st.ino}` : null;
}

/** Single line, single spaces, trimmed. */
export function normalizeCaption(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function tagsOf(caption: string): string[] {
  return caption.split(',').map((t) => t.trim()).filter(Boolean);
}

/** Reads a sidecar; absent, symlinked and non-regular files read as null (never followed out of the library). */
async function readSmall(file: string): Promise<Buffer | null> {
  let fh: fs.promises.FileHandle;
  try {
    fh = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP') return null;
    throw err;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return null;
    if (st.size > MAX_SIDECAR_BYTES) throw new Error('sidecar file is too large');
    return await fh.readFile();
  } finally {
    await fh.close();
  }
}

/** Reads both sidecars of a media file located in `dir`. */
export async function readSidecars(dir: string, mediaName: string): Promise<SidecarState> {
  const names = sidecarNames(mediaName);
  const [txtBuf, jsonBuf] = await Promise.all([readSmall(path.join(dir, names.txt)), readSmall(path.join(dir, names.json))]);
  let json: CaptionJson | null = null;
  let jsonError: string | null = null;
  if (jsonBuf) {
    try {
      const v = JSON.parse(jsonBuf.toString('utf8'));
      if (v && typeof v === 'object' && !Array.isArray(v)) json = v;
      else jsonError = 'not a JSON object';
    } catch (err) {
      jsonError = (err as Error).message;
    }
  }
  return {
    txt: txtBuf ? txtBuf.toString('utf8') : null,
    txtSha256: txtBuf ? sha256(txtBuf) : null,
    json,
    jsonSha256: jsonBuf ? sha256(jsonBuf) : null,
    jsonError,
  };
}

/**
 * Status as the pipeline would see it: a .txt that differs from the hash the json
 * recorded was edited by some other tool (human-protected), and a bare .txt with
 * no json is treated the same way.
 */
export function effectiveStatus(s: Pick<SidecarState, 'txt' | 'txtSha256' | 'json'>): CaptionStatus | null {
  if (!s.json) return s.txt !== null ? 'edited' : null;
  const raw = s.json.status;
  const status: CaptionStatus = (CAPTION_STATUSES as readonly unknown[]).includes(raw) ? (raw as CaptionStatus) : 'edited';
  if (status === 'generated' && s.txtSha256 && s.json.caption_sha256 !== s.txtSha256) return 'edited';
  return status;
}

export function hasCandidate(json: CaptionJson | null): boolean {
  return !!json && !!json.candidate && typeof json.candidate === 'object';
}

/** Writes via a temp file in the same directory, fsync and rename, so readers never see a partial file. */
async function writeAtomic(file: string, data: string) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  const fh = await fs.promises.open(tmp, 'wx');
  try {
    await fh.writeFile(data, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fs.promises.rename(tmp, file);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true });
    throw err;
  }
  const dh = await fs.promises.open(dir, 'r').catch(() => null);
  await dh?.sync().catch(() => {});
  await dh?.close();
}

export type CaptionAction = 'save' | 'approve' | 'needs_regen' | 'accept_candidate' | 'discard_candidate';
const ACTIONS: CaptionAction[] = ['save', 'approve', 'needs_regen', 'accept_candidate', 'discard_candidate'];

export interface CaptionRequest {
  action: CaptionAction;
  caption?: string;
  approve?: boolean;
  /** What the client loaded: the json's updated_at and the .txt sha256 (null when absent). */
  updated_at: string | null;
  txt_sha256: string | null;
  /** Optional stricter check: sha256 of the whole json file as loaded. */
  json_sha256?: string | null;
}

export function parseCaptionRequest(body: unknown): CaptionRequest {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!ACTIONS.includes(b.action as CaptionAction)) throw new HttpError(`action must be one of ${ACTIONS.join(', ')}`, 400);
  const optStr = (k: string) => {
    if (b[k] === null) return null;
    if (typeof b[k] !== 'string') throw new HttpError(`${k} must be a string or null`, 400);
    return b[k] as string;
  };
  const req: CaptionRequest = { action: b.action as CaptionAction, updated_at: optStr('updated_at'), txt_sha256: optStr('txt_sha256') };
  if (b.json_sha256 !== undefined) req.json_sha256 = optStr('json_sha256');
  if (req.action === 'save') {
    if (typeof b.caption !== 'string') throw new HttpError('caption must be a string', 400);
    req.caption = b.caption;
    req.approve = b.approve === true;
  }
  return req;
}

export class Captions {
  constructor(readonly db: Db, readonly indexer: Indexer) {}

  /** Directory holding the asset (where it is linked, not where a symlink points) and the library's writability. */
  private async location(row: AssetRow) {
    const state = this.indexer.libs.get(row.library_id);
    if (!state?.realRoot) throw new HttpError('library is unavailable', 404);
    const dir = path.dirname(path.join(state.realRoot, ...row.rel_path.split('/')));
    const realDir = await fs.promises.realpath(dir).catch(() => {
      throw new HttpError('file not found', 404);
    });
    if (!isInside(state.realRoot, realDir)) throw new HttpError('path escapes library');
    return { dir: realDir, lib: state.cfg };
  }

  async get(row: AssetRow) {
    const { dir, lib } = await this.location(row);
    const s = await readSidecars(dir, row.name);
    return { ...s, status: effectiveStatus(s), writable: lib.writable };
  }

  act(row: AssetRow, req: CaptionRequest) {
    return this.indexer.exclusive(() => this.doAct(row.id, req));
  }

  private async doAct(id: number, req: CaptionRequest) {
    const row = this.db.asset(id);
    if (!row || row.status !== 'ready') throw new HttpError('asset not found', 404);
    const { dir, lib } = await this.location(row);
    if (!lib.writable) throw new HttpError(`Library "${lib.name}" is read-only`, 403);
    const names = sidecarNames(row.name);
    const txtFile = path.join(dir, names.txt);
    const jsonFile = path.join(dir, names.json);
    for (const f of [txtFile, jsonFile]) {
      const st = await fs.promises.lstat(f).catch(() => null);
      if (st && !st.isFile()) throw new HttpError('Caption sidecars must be regular files', 400);
    }

    // Optimistic concurrency: refuse if either file changed since the client loaded it.
    const cur = await readSidecars(dir, row.name);
    if (cur.jsonError) throw new HttpError(`The caption json cannot be parsed: ${cur.jsonError}`, 409);
    const curUpdated = typeof cur.json?.updated_at === 'string' ? cur.json.updated_at : null;
    if (curUpdated !== req.updated_at || cur.txtSha256 !== req.txt_sha256 ||
        (req.json_sha256 !== undefined && req.json_sha256 !== cur.jsonSha256)) {
      throw new HttpError('The caption changed on disk. It has been reloaded; review and try again.', 409);
    }

    const now = new Date().toISOString();
    const json: CaptionJson = cur.json ? { ...cur.json } : await this.minimalJson(row, dir);
    let txt: string | null = null;
    const setPrimaryCaption = (caption: string) => {
      txt = caption;
      json.caption = caption;
      json.tags = tagsOf(caption);
      json.caption_sha256 = sha256(caption);
    };

    switch (req.action) {
      case 'save': {
        const caption = normalizeCaption(req.caption ?? '');
        if (!caption) throw new HttpError('The caption cannot be empty', 400);
        if (caption === cur.txt && !req.approve && cur.json) return this.get(row);
        setPrimaryCaption(caption);
        json.status = req.approve ? 'approved' : 'edited';
        break;
      }
      case 'approve':
        if (cur.txt === null) throw new HttpError('There is no caption to approve', 409);
        json.caption = cur.txt;
        json.tags = tagsOf(cur.txt);
        json.caption_sha256 = cur.txtSha256;
        json.status = 'approved';
        break;
      case 'needs_regen':
        json.status = 'needs_regen';
        break;
      case 'accept_candidate': {
        const cand = json.candidate as Record<string, unknown> | null | undefined;
        if (!cand || typeof cand !== 'object' || typeof cand.caption !== 'string') {
          throw new HttpError('There is no candidate caption', 409);
        }
        const caption = normalizeCaption(cand.caption);
        if (!caption) throw new HttpError('The candidate caption is empty', 409);
        json.previous = { caption: cur.txt, status: effectiveStatus(cur), replaced_at: now };
        for (const k of ['description', 'classification', 'raw', 'generation'] as const) {
          if (k in cand) json[k] = cand[k];
        }
        setPrimaryCaption(caption);
        json.status = 'edited';
        json.candidate = null;
        break;
      }
      case 'discard_candidate':
        json.candidate = null;
        break;
    }
    json.review = { updated_at: now, by: 'gallery' };
    json.updated_at = now;

    try {
      if (txt !== null) await writeAtomic(txtFile, txt);
      await writeAtomic(jsonFile, JSON.stringify(json, null, 2) + '\n');
    } catch (err) {
      throw new HttpError(`Could not write caption: ${(err as Error).message}`, 500);
    }
    // Update the cache right away; the watcher event that follows finds it unchanged.
    if (await this.indexer.syncCaption(row)) this.indexer.notify(row.library_id, [], [row.id]);
    return this.get(row);
  }

  /** A json for a caption that so far only had a .txt (or nothing). */
  private async minimalJson(row: AssetRow, dir: string): Promise<CaptionJson> {
    const image = await fs.promises.readFile(path.join(dir, row.name)).catch(() => null);
    return {
      schema: CAPTION_SCHEMA,
      image: row.name,
      ...(image ? { image_sha256: sha256(image) } : {}),
      status: 'edited',
      candidate: null,
      previous: null,
    };
  }
}
