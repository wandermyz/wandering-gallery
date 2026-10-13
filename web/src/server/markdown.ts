import fs from 'node:fs';
import path from 'node:path';
import { marked, type Token } from 'marked';

/**
 * Markdown documents are assets like images and videos. The text is read on demand
 * (it is the source of truth); references to other files are resolved against the
 * document's folder, so `![](pic.png)` next to the document shows that gallery image.
 */

/** Larger documents are not rendered (they can still be downloaded). */
export const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;

export async function readMarkdown(file: string): Promise<string> {
  const fh = await fs.promises.open(file, fs.constants.O_RDONLY);
  try {
    const st = await fh.stat();
    if (st.size > MAX_MARKDOWN_BYTES) throw new Error('document is too large to show');
    return (await fh.readFile()).toString('utf8').replace(/^﻿/, '');
  } finally {
    await fh.close();
  }
}

/** `src`, `poster` and `href` attributes in raw HTML (`<video src="clip.mp4">`). */
export const HTML_URL_ATTR = /\b(src|poster|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;

const decodeEntities = (s: string) =>
  s.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'" })[e]!);

/**
 * Every URL the document refers to, exactly as written (link and image targets, and
 * URL attributes in raw HTML). The browser renders with the same lexer and looks
 * these strings up in the server's answer.
 */
export function markdownRefs(text: string): string[] {
  const out = new Set<string>();
  marked.walkTokens(marked.lexer(text), (t: Token) => {
    if ((t.type === 'image' || t.type === 'link') && typeof t.href === 'string') out.add(t.href);
    else if (t.type === 'html' && typeof t.text === 'string') {
      for (const m of t.text.matchAll(HTML_URL_ATTR)) out.add(decodeEntities(m[2] ?? m[3] ?? m[4] ?? ''));
    }
  });
  out.delete('');
  return [...out].slice(0, 1000);
}

/**
 * The library-relative path a reference points to, or null for external URLs,
 * anchors, and paths that leave the library. A leading `/` is the library root.
 */
export function resolveRef(ref: string, folder: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//') || ref.startsWith('#')) return null;
  let p = ref.replace(/[?#].*$/, '');
  try {
    p = decodeURIComponent(p);
  } catch {
    /* keep as written */
  }
  if (!p || p.includes('\0')) return null;
  const joined = p.startsWith('/') ? path.posix.normalize(p).slice(1) : path.posix.normalize(path.posix.join(folder || '.', p));
  if (!joined || joined === '.' || joined.startsWith('../') || joined === '..' || path.posix.isAbsolute(joined)) return null;
  return joined;
}

/** Title and plain-text excerpt, for the thumbnail card and the search index. */
export function markdownSummary(text: string): { title: string | null; body: string } {
  const plain = (s: string) => s
    .replace(/<[^>]*>/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  let title: string | null = null;
  const parts: string[] = [];
  marked.walkTokens(marked.lexer(text), (t: Token) => {
    if (t.type === 'heading' && title === null) title = plain(t.text);
    else if (t.type === 'heading' || t.type === 'paragraph' || t.type === 'code') parts.push(plain(t.text));
  });
  return { title: title || null, body: parts.filter(Boolean).join('\n') };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Rough rendered width in em: CJK and other full-width characters are 1em, the rest about half. */
const charWidth = (c: string) => (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(c) ? 1 : 0.56);

function wrap(text: string, maxEm: number, maxLines: number): string[] {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    let w = 0;
    for (const c of para) {
      const cw = charWidth(c);
      if (w + cw > maxEm) {
        // Break at the last space for Latin text; CJK can break anywhere.
        const sp = line.lastIndexOf(' ');
        const cut = cw < 1 && c !== ' ' && sp > line.length / 2 ? sp : line.length;
        lines.push(line.slice(0, cut).trimEnd());
        line = line.slice(cut).trimStart();
        w = [...line].reduce((n, x) => n + charWidth(x), 0);
        if (lines.length >= maxLines) break;
      }
      line += c;
      w += cw;
    }
    if (lines.length >= maxLines) break;
    if (line.trim()) lines.push(line.trim());
    if (lines.length >= maxLines) break;
  }
  if (lines.length >= maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = lines[maxLines - 1].replace(/.?$/, '…');
  }
  return lines;
}

/** A text card (title and the first lines) to thumbnail a document, as SVG. */
export async function markdownCard(file: string, size: number): Promise<Buffer> {
  const text = await readMarkdown(file).catch(() => '');
  const { title, body } = markdownSummary(text);
  const pad = size * 0.08;
  const width = size - pad * 2;
  const titleSize = size * 0.075;
  const bodySize = size * 0.05;
  const titleLines = wrap(title ?? path.basename(file), width / titleSize, 3);
  let y = pad + titleSize;
  const parts: string[] = [];
  for (const l of titleLines) {
    parts.push(`<text x="${pad}" y="${y}" font-size="${titleSize}" font-weight="700" fill="#ececf1">${esc(l)}</text>`);
    y += titleSize * 1.3;
  }
  y += bodySize * 0.6;
  const room = Math.max(0, Math.floor((size - pad - y) / (bodySize * 1.55)) + 1);
  for (const l of wrap(body, width / bodySize, room)) {
    parts.push(`<text x="${pad}" y="${y}" font-size="${bodySize}" fill="#a9a9b6">${esc(l)}</text>`);
    y += bodySize * 1.55;
  }
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<rect width="100%" height="100%" fill="#1a1a21"/>` +
    `<g font-family="Noto Sans CJK SC, Noto Sans CJK JP, Noto Sans, DejaVu Sans, sans-serif">${parts.join('')}</g></svg>`,
  );
}
