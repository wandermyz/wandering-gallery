import fs from 'node:fs';
import zlib from 'node:zlib';

/** Max size of a single text chunk we are willing to read (workflows can be large). */
const MAX_TEXT_CHUNK = 32 * 1024 * 1024;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface PngInfo {
  width: number;
  height: number;
  text: Record<string, string>;
  /** True once an IEND chunk is found, i.e. the file was completely written. */
  complete: boolean;
}

/**
 * Reads PNG header and text chunks (tEXt, zTXt, iTXt) without loading image
 * data. Pixel data chunks are skipped by seeking.
 */
export async function readPngInfo(file: string): Promise<PngInfo> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const head = Buffer.alloc(8);
    await fh.read(head, 0, 8, 0);
    if (!head.equals(PNG_SIG)) throw new Error('not a PNG file');
    const info: PngInfo = { width: 0, height: 0, text: {}, complete: false };
    let pos = 8;
    const hdr = Buffer.alloc(8);
    while (pos + 8 <= size) {
      await fh.read(hdr, 0, 8, pos);
      const len = hdr.readUInt32BE(0);
      const type = hdr.toString('latin1', 4, 8);
      const dataPos = pos + 8;
      if (dataPos + len + 4 > size) break; // truncated
      if (type === 'IHDR' && len >= 8) {
        const b = Buffer.alloc(8);
        await fh.read(b, 0, 8, dataPos);
        info.width = b.readUInt32BE(0);
        info.height = b.readUInt32BE(4);
      } else if ((type === 'tEXt' || type === 'zTXt' || type === 'iTXt') && len <= MAX_TEXT_CHUNK) {
        const b = Buffer.alloc(len);
        await fh.read(b, 0, len, dataPos);
        const entry = decodeTextChunk(type, b);
        if (entry && !(entry[0] in info.text)) info.text[entry[0]] = entry[1];
      } else if (type === 'IEND') {
        info.complete = true;
        break;
      }
      pos = dataPos + len + 4;
    }
    return info;
  } finally {
    await fh.close();
  }
}

function decodeTextChunk(type: string, b: Buffer): [string, string] | null {
  const nul = b.indexOf(0);
  if (nul <= 0) return null;
  const key = b.toString('latin1', 0, nul);
  try {
    if (type === 'tEXt') {
      // Spec says Latin-1, but ComfyUI (via Pillow) writes UTF-8 bytes for non-ASCII prompts.
      return [key, decodeMaybeUtf8(b.subarray(nul + 1))];
    }
    if (type === 'zTXt') {
      return [key, zlib.inflateSync(b.subarray(nul + 2), { maxOutputLength: MAX_TEXT_CHUNK }).toString('utf8')];
    }
    // iTXt: keyword\0 compFlag compMethod lang\0 translatedKeyword\0 text
    const compressed = b[nul + 1] === 1;
    let p = nul + 3;
    const langEnd = b.indexOf(0, p);
    if (langEnd < 0) return null;
    const tkEnd = b.indexOf(0, langEnd + 1);
    if (tkEnd < 0) return null;
    p = tkEnd + 1;
    const data = b.subarray(p);
    return [key, (compressed ? zlib.inflateSync(data, { maxOutputLength: MAX_TEXT_CHUNK }) : data).toString('utf8')];
  } catch {
    return null;
  }
}

function decodeMaybeUtf8(buf: Buffer): string {
  const s = buf.toString('utf8');
  return s.includes('�') ? buf.toString('latin1') : s;
}

/**
 * Extracts string tags from a raw EXIF block (TIFF structure), following the
 * Exif sub-IFD. Used for ComfyUI WebP/AVIF output (which stores
 * "workflow:{...}" / "prompt:{...}" in IFD0 ASCII tags) and A1111 JPEG
 * UserComment.
 */
export function readExifStrings(exif: Buffer): Record<number, string> {
  const out: Record<number, string> = {};
  let base = -1;
  for (let i = 0; i + 4 <= Math.min(exif.length, 32); i++) {
    const a = exif[i], b = exif[i + 1];
    if ((a === 0x49 && b === 0x49 && exif[i + 2] === 0x2a && exif[i + 3] === 0) ||
        (a === 0x4d && b === 0x4d && exif[i + 2] === 0 && exif[i + 3] === 0x2a)) {
      base = i;
      break;
    }
  }
  if (base < 0) return out;
  const le = exif[base] === 0x49;
  const u16 = (o: number) => (le ? exif.readUInt16LE(base + o) : exif.readUInt16BE(base + o));
  const u32 = (o: number) => (le ? exif.readUInt32LE(base + o) : exif.readUInt32BE(base + o));
  const inRange = (o: number, n: number) => o >= 0 && base + o + n <= exif.length;

  const visit = (ifd: number, depth: number) => {
    if (depth > 2 || !inRange(ifd, 2)) return;
    const count = u16(ifd);
    for (let i = 0; i < count && i < 512; i++) {
      const e = ifd + 2 + i * 12;
      if (!inRange(e, 12)) return;
      const tag = u16(e);
      const type = u16(e + 2);
      const n = u32(e + 4);
      if (tag === 0x8769 && depth === 0) {
        visit(u32(e + 8), depth + 1);
        continue;
      }
      if (type !== 2 && type !== 7) continue;
      const off = n <= 4 ? e + 8 : u32(e + 8);
      if (!inRange(off, n)) continue;
      let raw = exif.subarray(base + off, base + off + n);
      if (type === 7 && tag === 0x9286) {
        out[tag] = decodeUserComment(raw);
        continue;
      }
      while (raw.length && raw[raw.length - 1] === 0) raw = raw.subarray(0, raw.length - 1);
      out[tag] = raw.toString('utf8');
    }
  };
  visit(u32(4), 0);
  return out;
}

function decodeUserComment(raw: Buffer): string {
  const prefix = raw.toString('latin1', 0, 8);
  const body = raw.subarray(8);
  if (prefix.startsWith('UNICODE')) {
    // Usually UTF-16BE in A1111 output; detect LE by zero byte position.
    const le = body.length > 1 && body[0] !== 0 && body[1] === 0;
    const b = Buffer.from(body.subarray(0, body.length - (body.length % 2)));
    if (!le) b.swap16();
    return b.toString('utf16le').replace(/\0+$/, '');
  }
  return body.toString('utf8').replace(/\0+$/, '');
}
