import { Marked, type Tokens } from 'marked';
import DOMPurify from 'dompurify';
import { displayUrl, fileUrl, thumbUrl, type Asset } from './api';

/**
 * Renders a Markdown document from the gallery. Loaded on demand (it pulls in the
 * Markdown parser and the sanitizer), the first time a document is shown.
 *
 * `refs` maps each URL exactly as written in the document to the gallery asset it
 * resolves to (null: a local file that is missing, or hidden while locked). Those
 * become the gallery's own media URLs, so hiding rules apply to embedded media
 * too; an image reference that points to a video or audio file becomes a player.
 * ```mermaid code blocks are drawn as diagrams afterwards, by renderDiagrams (with Pele).
 */

/** Same pattern as the server's HTML_URL_ATTR, which collected the refs. */
const HTML_URL_ATTR = /\b(src|poster|href)(\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const decodeEntities = (s: string) =>
  s.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'" })[e]!);

/** Where an asset is opened from a link (handled by the viewer). */
export const ASSET_LINK_ATTR = 'data-asset';

function mediaHtml(a: Asset, alt: string, title: string | null): string {
  const t = title ? ` title="${esc(title)}"` : '';
  if (a.kind === 'video') {
    return `<video class="md-video" src="${fileUrl(a)}" poster="${thumbUrl(a)}" controls playsinline preload="metadata"${t}></video>`;
  }
  if (a.kind === 'audio') return `<audio class="md-audio" src="${fileUrl(a)}" controls preload="metadata"${t}></audio>`;
  if (a.kind === 'image') {
    const size = a.width && a.height ? ` width="${a.width}" height="${a.height}"` : '';
    return `<img class="md-img" src="${displayUrl(a)}" alt="${esc(alt)}"${size} loading="lazy" decoding="async"${t}>`;
  }
  // A document embedded as an image: link to it instead.
  return `<a href="#" ${ASSET_LINK_ATTR}="${a.id}">${esc(alt || a.name)}</a>`;
}

const missingHtml = (label: string) =>
  `<span class="md-missing" title="Not available">${esc(label || 'Missing file')}</span>`;

export function renderMarkdown(text: string, refs: Record<string, Asset | null>): string {
  const local = (href: string) => (Object.prototype.hasOwnProperty.call(refs, href) ? { asset: refs[href] } : null);
  const md = new Marked({ gfm: true, breaks: false });
  md.use({
    renderer: {
      code({ text: src, lang }: Tokens.Code) {
        if ((lang ?? '').trim().toLowerCase() !== 'mermaid') return false;
        // Shown as source until the diagram is drawn (or if it cannot be).
        return `<pre class="md-mermaid"><code>${esc(src)}</code></pre>`;
      },
      image({ href, title, text: alt }: Tokens.Image) {
        const r = local(href);
        if (!r) return false; // external URL: default rendering
        return r.asset ? mediaHtml(r.asset, alt, title) : missingHtml(alt || href);
      },
      link(this: { parser: { parseInline(t: Tokens.Link['tokens']): string } }, token: Tokens.Link) {
        const r = local(token.href);
        if (!r) return false;
        const inner = this.parser.parseInline(token.tokens);
        if (!r.asset) return `<span class="md-missing" title="Not available">${inner}</span>`;
        return `<a href="#" ${ASSET_LINK_ATTR}="${r.asset.id}">${inner}</a>`;
      },
      html({ text: html }: Tokens.HTML | Tokens.Tag) {
        // Raw HTML such as <video src="clip.mp4">: point local files at the gallery.
        return html.replace(HTML_URL_ATTR, (m, attr: string, eq: string, a?: string, b?: string, c?: string) => {
          const r = local(decodeEntities(a ?? b ?? c ?? ''));
          if (!r) return m;
          const name = attr.toLowerCase();
          if (!r.asset) return `${attr}${eq}""`;
          const url = name === 'poster' ? thumbUrl(r.asset) : name === 'href' ? '#' : r.asset.kind === 'image' ? displayUrl(r.asset) : fileUrl(r.asset);
          return `${attr}${eq}"${url}"${name === 'href' ? ` ${ASSET_LINK_ATTR}="${r.asset.id}"` : ''}`;
        });
      },
    },
  });
  const html = md.parse(text, { async: false }) as string;
  return sanitize(html);
}

let hooked = false;

function sanitize(html: string): string {
  if (!hooked) {
    hooked = true;
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A' && !node.hasAttribute(ASSET_LINK_ATTR)) {
        const href = node.getAttribute('href') ?? '';
        if (!href.startsWith('#')) {
          node.setAttribute('target', '_blank');
          node.setAttribute('rel', 'noopener noreferrer');
        }
      }
      if (node.tagName === 'AUDIO') {
        node.setAttribute('controls', '');
        if (!node.hasAttribute('preload')) node.setAttribute('preload', 'metadata');
      }
      if (node.tagName === 'VIDEO') {
        node.setAttribute('playsinline', '');
        node.setAttribute('controls', '');
        if (!node.hasAttribute('preload')) node.setAttribute('preload', 'metadata');
      }
      if (node.tagName === 'IMG' && !node.hasAttribute('loading')) node.setAttribute('loading', 'lazy');
    });
  }
  return DOMPurify.sanitize(html, {
    ADD_TAGS: ['video', 'audio', 'source'],
    ADD_ATTR: ['controls', 'playsinline', 'loop', 'muted', 'poster', 'preload', 'autoplay', ASSET_LINK_ATTR],
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'select', 'iframe'],
  });
}

type Pele = typeof import('pele/lazy');
let pele: Promise<Pele> | null = null;

/**
 * The diagrams' colors, matching the app's dark theme. Set on each diagram's own <svg>,
 * so a copy of it (the full-screen view, the iOS app's zoom view) keeps them.
 */
const DIAGRAM_THEME: Record<string, string> = {
  '--pele-bg': '#050707',
  '--pele-fg': '#f5f8f8',
  '--pele-muted': '#a8b1b0',
  '--pele-line': '#b4bfbe',
  '--pele-surface': '#151a1a',
  '--pele-surface-alt': '#0d1111',
  '--pele-border': '#3e4a49',
  '--pele-accent': '#39d8c7',
  '--pele-critical': '#ff6685',
};

/**
 * Draws the Mermaid diagrams in a rendered document, in place, with Pele. It is loaded
 * only for documents that have diagrams, and each diagram type's code only when one is
 * drawn. Pele escapes labels and filters links and styles; it runs no scripts. A diagram
 * that cannot be drawn stays as source.
 */
export async function renderDiagrams(root: HTMLElement, alive: () => boolean): Promise<void> {
  const blocks = [...root.querySelectorAll<HTMLElement>('pre.md-mermaid')];
  if (!blocks.length) return;
  pele ??= import('pele/lazy');
  const { renderAsync } = await pele;
  const fontFamily = getComputedStyle(root).fontFamily;
  for (const pre of blocks) {
    if (!alive() || !pre.isConnected) return;
    try {
      // Laid out for the column's width: a wide flowchart turns vertical on a phone.
      const { svg } = await renderAsync(pre.textContent ?? '', { fontFamily, maxWidth: root.clientWidth || undefined });
      if (!alive() || !pre.isConnected) return;
      const fig = document.createElement('div');
      fig.className = 'md-diagram';
      fig.innerHTML = svg;
      const el = fig.querySelector('svg');
      for (const [k, v] of Object.entries(DIAGRAM_THEME)) el?.style.setProperty(k, v);
      pre.replaceWith(fig);
    } catch (e) {
      pre.classList.add('md-mermaid-error');
      pre.title = `Diagram could not be drawn: ${(e as Error).message}`;
    }
  }
}
