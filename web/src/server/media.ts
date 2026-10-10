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

const TXT = '.txt';
const CAPTION_JSON = '.caption.json';

/** File name without its extension (`a.b.png` -> `a.b`). */
export function stemOf(name: string): string {
  return name.slice(0, name.length - path.extname(name).length);
}

/**
 * For a caption sidecar name (`<stem>.txt` or `<stem>.caption.json`), the stem of
 * the media file it belongs to; null for any other file.
 */
export function sidecarStem(name: string): string | null {
  if (name.endsWith(CAPTION_JSON) && name.length > CAPTION_JSON.length) return name.slice(0, -CAPTION_JSON.length);
  if (name.endsWith(TXT) && name.length > TXT.length) return name.slice(0, -TXT.length);
  return null;
}

/** Caption sidecar names for a media file name. */
export function sidecarNames(mediaName: string): { txt: string; json: string } {
  const stem = stemOf(mediaName);
  return { txt: stem + TXT, json: stem + CAPTION_JSON };
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
