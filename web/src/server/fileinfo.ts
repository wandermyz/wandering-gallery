import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const FP_CHUNK = 64 * 1024;

/**
 * Cheap content fingerprint: hash of size + first and last 64 KiB. Used to
 * recognise a file after it is moved or renamed, and as the thumbnail cache key.
 */
export async function fingerprint(file: string): Promise<string> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const hash = crypto.createHash('sha1');
    hash.update(String(size));
    const head = Buffer.alloc(Math.min(FP_CHUNK, size));
    await fh.read(head, 0, head.length, 0);
    hash.update(head);
    if (size > FP_CHUNK) {
      const len = Math.min(FP_CHUNK, size - FP_CHUNK);
      const tail = Buffer.alloc(len);
      await fh.read(tail, 0, len, size - len);
      hash.update(tail);
    }
    return hash.digest('hex').slice(0, 32);
  } finally {
    await fh.close();
  }
}

async function readAt(fh: fs.promises.FileHandle, pos: number, len: number): Promise<Buffer> {
  const b = Buffer.alloc(len);
  const { bytesRead } = await fh.read(b, 0, len, pos);
  return b.subarray(0, bytesRead);
}

const IEND = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

/**
 * Checks whether a file looks completely written, based on its container
 * structure. ComfyUI writes images straight to their final path (no temp file +
 * rename), and video muxers write the `moov` index last (then relocate it to the
 * front for faststart), so a partially written file usually fails these checks.
 * Returns true for formats without a reliable end marker (WebM): those rely on
 * the size/mtime stability window alone.
 */
export async function looksComplete(file: string): Promise<boolean> {
  const ext = path.extname(file).toLowerCase();
  const fh = await fs.promises.open(file, 'r');
  try {
    const { size } = await fh.stat();
    if (size === 0) return false;
    switch (ext) {
      case '.png': {
        if (size < 20) return false;
        const tail = await readAt(fh, size - 12, 12);
        if (tail.equals(IEND)) return true;
        // Tolerate trailing junk after IEND.
        const window = await readAt(fh, Math.max(0, size - 4096), Math.min(size, 4096));
        return window.includes(IEND.subarray(4, 8));
      }
      case '.jpg':
      case '.jpeg': {
        const tail = await readAt(fh, Math.max(0, size - 1024), Math.min(size, 1024));
        for (let i = tail.length - 2; i >= 0; i--) if (tail[i] === 0xff && tail[i + 1] === 0xd9) return true;
        return false;
      }
      case '.gif': {
        const tail = await readAt(fh, size - 1, 1);
        return tail[0] === 0x3b;
      }
      case '.webp': {
        const head = await readAt(fh, 0, 12);
        if (head.length < 12 || head.toString('latin1', 0, 4) !== 'RIFF') return false;
        return head.readUInt32LE(4) + 8 <= size;
      }
      case '.mp4':
      case '.m4v':
      case '.mov':
      case '.avif':
        return await isobmffComplete(fh, size, ext === '.avif' ? 'meta' : 'moov');
      default:
        return true;
    }
  } finally {
    await fh.close();
  }
}

async function isobmffComplete(fh: fs.promises.FileHandle, size: number, required: string): Promise<boolean> {
  let pos = 0;
  let found = false;
  for (let i = 0; i < 10000 && pos < size; i++) {
    const h = await readAt(fh, pos, 16);
    if (h.length < 8) return false;
    let boxSize = h.readUInt32BE(0);
    const type = h.toString('latin1', 4, 8);
    if (boxSize === 1) {
      if (h.length < 16) return false;
      boxSize = Number(h.readBigUInt64BE(8));
    } else if (boxSize === 0) {
      boxSize = size - pos; // extends to EOF
    }
    if (boxSize < 8 || pos + boxSize > size) return false;
    if (type === required) found = true;
    pos += boxSize;
  }
  return found && pos === size;
}
