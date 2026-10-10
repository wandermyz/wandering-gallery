import path from 'node:path';

export type MediaKind = 'image' | 'video';

interface TypeInfo {
  kind: MediaKind;
  mime: string;
}

const TYPES: Record<string, TypeInfo> = {
  '.png': { kind: 'image', mime: 'image/png' },
  '.jpg': { kind: 'image', mime: 'image/jpeg' },
  '.jpeg': { kind: 'image', mime: 'image/jpeg' },
  '.webp': { kind: 'image', mime: 'image/webp' },
  '.gif': { kind: 'image', mime: 'image/gif' },
  '.avif': { kind: 'image', mime: 'image/avif' },
  '.mp4': { kind: 'video', mime: 'video/mp4' },
  '.m4v': { kind: 'video', mime: 'video/mp4' },
  '.webm': { kind: 'video', mime: 'video/webm' },
  '.mov': { kind: 'video', mime: 'video/quicktime' },
};

export function mediaType(file: string): TypeInfo | null {
  return TYPES[path.extname(file).toLowerCase()] ?? null;
}

/** Hidden files/dirs and well-known junk are never indexed. */
export function isIgnoredName(name: string): boolean {
  return name.startsWith('.') || name.startsWith('~') || name === '@eaDir' || name === '__pycache__';
}

/**
 * Codec support across Safari (iOS) and Chromium/Firefox. 'partial' means some
 * browsers (usually Safari, or Chrome with hardware support) can play it.
 */
export function videoPlayability(codec: string | null | undefined): 'yes' | 'partial' | 'no' | 'unknown' {
  if (!codec) return 'unknown';
  switch (codec.toLowerCase()) {
    case 'h264':
    case 'vp8':
    case 'vp9':
    case 'av1':
      return 'yes';
    case 'hevc':
    case 'h265':
      return 'partial';
    default:
      return 'no';
  }
}
