import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { markdownCard } from './markdown.js';
import { run } from './proc.js';
import type { MediaKind } from './media.js';

// Keep libvips light: one thread, small cache. Thumbnailing is background work.
sharp.concurrency(1);
sharp.cache({ memory: 64, files: 0, items: 32 });

export interface ThumbOptions {
  cacheDir: string;
  size: number;
  quality: number;
  ffmpeg: string;
}

/**
 * Thumbnails are keyed by content fingerprint, so an unchanged file never gets
 * regenerated, a moved file reuses its thumbnail, and a replaced file gets a
 * fresh one automatically.
 */
export function thumbPath(cacheDir: string, fingerprint: string, size: number): string {
  if (!/^[0-9a-f]{8,64}$/.test(fingerprint)) throw new Error('bad fingerprint');
  return path.join(cacheDir, 'thumbs', String(size), fingerprint.slice(0, 2), `${fingerprint}.webp`);
}

const inflight = new Map<string, Promise<string>>();

/** At most two decode jobs at once (worker + on-demand requests), to stay light on CPU. */
const MAX_JOBS = 2;
let active = 0;
const waiting: (() => void)[] = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_JOBS) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

export function ensureThumb(file: string, kind: MediaKind, fingerprint: string, opts: ThumbOptions): Promise<string> {
  return ensureResized(file, kind, thumbPath(opts.cacheDir, fingerprint, opts.size), opts);
}

/** Size of the screen-sized preview used by the viewer instead of very large originals. */
export const PREVIEW_SIZE = 2048;

export function ensurePreview(file: string, fingerprint: string, opts: ThumbOptions): Promise<string> {
  return ensureResized(file, 'image', thumbPath(opts.cacheDir, fingerprint, PREVIEW_SIZE),
    { ...opts, size: PREVIEW_SIZE, quality: Math.max(opts.quality, 85) });
}

function ensureResized(file: string, kind: MediaKind, out: string, opts: ThumbOptions): Promise<string> {
  const existing = inflight.get(out);
  if (existing) return existing;
  const job = (async () => {
    try {
      await fs.promises.access(out);
      return out;
    } catch {
      /* not cached yet */
    }
    await fs.promises.mkdir(path.dirname(out), { recursive: true });
    const tmp = `${out}.${process.pid}.tmp`;
    return withSlot(async () => {
      try {
        const input = kind === 'video' ? await videoFrame(file, opts) : kind === 'markdown' ? await markdownCard(file, opts.size) : file;
        await sharp(input, { failOn: 'none', limitInputPixels: 2 ** 28 })
          .rotate()
          .resize({ width: opts.size, height: opts.size, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: opts.quality, effort: 2 })
          .toFile(tmp);
        await fs.promises.rename(tmp, out);
        return out;
      } catch (err) {
        await fs.promises.rm(tmp, { force: true });
        throw err;
      }
    });
  })().finally(() => inflight.delete(out));
  inflight.set(out, job);
  return job;
}

/** Grabs a representative frame (~1s in, or first frame for short clips) as PNG. */
async function videoFrame(file: string, opts: ThumbOptions): Promise<Buffer> {
  const grab = async (seek: string | null) => {
    const args = ['-v', 'error', '-nostdin', '-threads', '1'];
    if (seek) args.push('-ss', seek);
    args.push('-i', path.resolve(file), '-frames:v', '1', '-an', '-sn',
      '-vf', `scale='min(${opts.size * 2},iw)':-2`, '-f', 'image2pipe', '-c:v', 'png', 'pipe:1');
    return (await run(opts.ffmpeg, args, { timeoutMs: 60_000, maxBytes: 32 * 1024 * 1024 })).stdout;
  };
  let buf = await grab('1').catch(() => Buffer.alloc(0));
  if (buf.length === 0) buf = await grab(null);
  if (buf.length === 0) throw new Error('could not decode a video frame');
  return buf;
}

/** Removes cached thumbnails whose fingerprint no longer belongs to any asset. */
export async function pruneThumbs(cacheDir: string, size: number, keep: Set<string>): Promise<number> {
  const root = path.join(cacheDir, 'thumbs', String(size));
  let removed = 0;
  let dirs: string[];
  try {
    dirs = await fs.promises.readdir(root);
  } catch {
    return 0;
  }
  for (const d of dirs) {
    const dir = path.join(root, d);
    for (const f of await fs.promises.readdir(dir).catch(() => [] as string[])) {
      const fp = f.replace(/\.webp$/, '');
      if (!keep.has(fp)) {
        await fs.promises.rm(path.join(dir, f), { force: true });
        removed++;
      }
    }
  }
  return removed;
}
