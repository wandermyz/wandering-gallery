import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import { parseConfig, type AppConfig } from '../src/server/config.js';
import { Db } from '../src/server/db.js';
import { Indexer, type Logger } from '../src/server/indexer.js';
import { Trash } from '../src/server/trash.js';

export const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'comfyui');

export function fixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

export function tmpDir(prefix = 'wg-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export const FFMPEG = process.env.FFMPEG ?? findTool('ffmpeg');
export const FFPROBE = process.env.FFPROBE ?? findTool('ffprobe');

function findTool(name: string): string {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return name;
}

export const hasFfmpeg = (() => {
  try {
    execFileSync(FFMPEG, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const silent: Logger = { info() {}, warn() {}, error() {} };

// ---- PNG text chunk writer (mirrors what ComfyUI/Pillow produce) ------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Inserts text chunks right after IHDR, like Pillow's PngInfo does. */
export function addPngText(png: Buffer, entries: Record<string, string>, kind: 'tEXt' | 'zTXt' | 'iTXt' = 'tEXt'): Buffer {
  const ihdrEnd = 8 + 8 + png.readUInt32BE(8) + 4;
  const chunks = Object.entries(entries).map(([k, v]) => {
    const key = Buffer.from(k, 'latin1');
    if (kind === 'tEXt') return chunk('tEXt', Buffer.concat([key, Buffer.from([0]), Buffer.from(v, 'utf8')]));
    if (kind === 'zTXt') return chunk('zTXt', Buffer.concat([key, Buffer.from([0, 0]), zlib.deflateSync(Buffer.from(v, 'utf8'))]));
    return chunk('iTXt', Buffer.concat([key, Buffer.from([0, 1, 0, 0, 0]), zlib.deflateSync(Buffer.from(v, 'utf8'))]));
  });
  return Buffer.concat([png.subarray(0, ihdrEnd), ...chunks, png.subarray(ihdrEnd)]);
}

export async function makePng(file: string, opts: { w?: number; h?: number; color?: string; text?: Record<string, string>; kind?: 'tEXt' | 'zTXt' | 'iTXt' } = {}) {
  const { w = 64, h = 96, color = '#336699' } = opts;
  let png: Buffer = await sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toBuffer();
  if (opts.text) png = addPngText(png, opts.text, opts.kind);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, png);
  return png;
}

/** Builds a minimal little-endian TIFF/EXIF block with ASCII tags in IFD0. */
export function makeExif(tags: Record<number, string>): Buffer {
  const entries = Object.entries(tags).map(([t, v]) => [Number(t), Buffer.from(v + '\0', 'utf8')] as const);
  const ifdSize = 2 + entries.length * 12 + 4;
  let dataOff = 8 + ifdSize;
  const head = Buffer.from([0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0]);
  const ifd = Buffer.alloc(ifdSize);
  ifd.writeUInt16LE(entries.length, 0);
  const datas: Buffer[] = [];
  entries.sort((a, b) => a[0] - b[0]).forEach(([tag, data], i) => {
    const e = 2 + i * 12;
    ifd.writeUInt16LE(tag, e);
    ifd.writeUInt16LE(2, e + 2);
    ifd.writeUInt32LE(data.length, e + 4);
    if (data.length <= 4) data.copy(ifd, e + 8);
    else {
      ifd.writeUInt32LE(dataOff, e + 8);
      datas.push(data);
      dataOff += data.length;
    }
  });
  return Buffer.concat([head, ifd, ...datas]);
}

export async function makeWebp(file: string, exifTags?: Record<number, string>) {
  let img = sharp({ create: { width: 80, height: 60, channels: 3, background: '#aa4422' } }).webp();
  if (exifTags) {
    // sharp writes EXIF from an object of IFD0 string values.
    const ifd0: Record<string, string> = {};
    for (const [tag, v] of Object.entries(exifTags)) {
      const name = ({ 0x010e: 'ImageDescription', 0x010f: 'Make', 0x0110: 'Model' } as Record<number, string>)[Number(tag)];
      if (name) ifd0[name] = v;
    }
    img = img.withExif({ IFD0: ifd0 });
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await img.toFile(file);
}

export async function makeJpeg(file: string, color = '#22aa44') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await sharp({ create: { width: 120, height: 80, channels: 3, background: color } }).jpeg().toFile(file);
}

export function makeVideo(file: string, opts: { seconds?: number; metadata?: Record<string, string>; codec?: 'h264' | 'vp9' } = {}) {
  const { seconds = 1, metadata = {}, codec = 'h264' } = opts;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const args = ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc=size=160x120:rate=10:duration=${seconds}`];
  for (const [k, v] of Object.entries(metadata)) args.push('-metadata', `${k}=${v}`);
  if (codec === 'h264') args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', 'use_metadata_tags+faststart');
  else args.push('-c:v', 'libvpx-vp9', '-b:v', '100k');
  args.push(file);
  execFileSync(FFMPEG, args);
}

/** Sets a file's mtime into the past so the stability window does not defer it. */
export function age(file: string, seconds = 120) {
  const t = new Date(Date.now() - seconds * 1000);
  fs.utimesSync(file, t, t);
}

export function ageAll(dir: string, seconds = 120) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (ent.isFile()) age(path.join(ent.parentPath, ent.name), seconds);
  }
}

// ---- App fixture ----------------------------------------------------------------------

export interface Env {
  root: string;
  cfg: AppConfig;
  db: Db;
  indexer: Indexer;
  trash: Trash;
  lib(id: string): string;
  /** Runs the scanner + indexes everything pending, synchronously from the test's view. */
  sync(): Promise<void>;
  close(): Promise<void>;
}

export async function makeEnv(libraries: { id: string; writable?: boolean; recursive?: boolean; showInAll?: boolean; hidden?: boolean }[] = [{ id: 'main', writable: true }], extra: Record<string, unknown> = {}): Promise<Env> {
  const root = tmpDir();
  for (const l of libraries) fs.mkdirSync(path.join(root, 'libs', l.id), { recursive: true });
  const cfg = parseConfig({
    dataDir: path.join(root, 'data'),
    cacheDir: path.join(root, 'cache'),
    scan: { stableSeconds: 1, intervalMinutes: 0 },
    tools: { ffmpeg: FFMPEG, ffprobe: FFPROBE },
    libraries: libraries.map((l) => ({ id: l.id, name: l.id.toUpperCase(), path: path.join(root, 'libs', l.id), writable: l.writable ?? true, recursive: l.recursive ?? true, showInAll: l.showInAll, hidden: l.hidden })),
    ...extra,
  });
  const db = new Db(path.join(cfg.dataDir, 'gallery.db'));
  const indexer = new Indexer(cfg, db, silent);
  const trash = new Trash(cfg, db, indexer);
  await indexer.start({ watch: false, worker: false });
  await indexer.scanAll();
  const env: Env = {
    root, cfg, db, indexer, trash,
    lib: (id) => path.join(root, 'libs', id),
    async sync() {
      await indexer.scanAll();
      for (;;) {
        const row = db.get<import('../src/server/db.js').AssetRow>(
          "SELECT * FROM assets WHERE status = 'ready' AND index_state = 'pending' LIMIT 1");
        if (!row) break;
        await indexer.indexOne(row);
      }
    },
    async close() {
      await indexer.stop();
      db.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
  return env;
}

export function sha(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
