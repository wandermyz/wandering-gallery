import path from 'node:path';

export type MediaKind = 'image' | 'video' | 'audio' | 'markdown';

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
  '.mp3': { kind: 'audio', mime: 'audio/mpeg' },
  '.m4a': { kind: 'audio', mime: 'audio/mp4' },
  '.aac': { kind: 'audio', mime: 'audio/aac' },
  '.wav': { kind: 'audio', mime: 'audio/wav' },
  '.flac': { kind: 'audio', mime: 'audio/flac' },
  '.ogg': { kind: 'audio', mime: 'audio/ogg' },
  '.oga': { kind: 'audio', mime: 'audio/ogg' },
  '.opus': { kind: 'audio', mime: 'audio/ogg' },
  '.md': { kind: 'markdown', mime: 'text/markdown; charset=utf-8' },
  '.markdown': { kind: 'markdown', mime: 'text/markdown; charset=utf-8' },
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

/**
 * Whether a file can own caption sidecars. Documents and audio cannot, so `story.md`
 * or `ComfyUI_00001_.flac` next to an image with the same stem never claims (or moves,
 * or deletes) the image's `.txt`.
 */
export function ownsSidecars(name: string): boolean {
  const kind = mediaType(name)?.kind;
  return kind !== 'markdown' && kind !== 'audio';
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

/** Audio codecs every current browser decodes; others (ALAC, WMA, AC-3…) may not play. */
export function audioPlayability(codec: string | null | undefined): 'yes' | 'partial' | 'no' | 'unknown' {
  if (!codec) return 'unknown';
  const c = codec.toLowerCase();
  if (['mp3', 'aac', 'flac', 'opus', 'vorbis'].includes(c) || c.startsWith('pcm_')) return 'yes';
  if (c === 'alac' || c === 'ac3' || c === 'eac3') return 'partial';
  return 'no';
}
