import { renderDiagrams, renderMarkdown, ASSET_LINK_ATTR } from '../client/gallery/markdown';
import { displayUrl, type Asset } from '../client/gallery/api';
import styles from '../client/styles.css?inline';

/**
 * The web client's Markdown renderer for the iOS app's WKWebView, built into one script
 * by `npm run build:ios-markdown` (into ios/WanderingGallery/Resources/Markdown).
 *
 * The page is loaded with the server as its base URL, so the gallery's relative media
 * URLs resolve. Taps are reported to the app through the `wg` message handler:
 * `{type: 'asset', id}` (a link to an asset or an embedded image), `{type: 'link', href}`
 * (any other link) and `{type: 'diagram', svg}` (a Mermaid diagram, to zoom into).
 */

interface Doc {
  text: string;
  refs: Record<string, Asset | null>;
}

declare global {
  interface Window {
    wgRender(doc: Doc): Promise<void>;
    webkit?: { messageHandlers?: { wg?: { postMessage(m: unknown): void } } };
  }
}

const post = (m: unknown) => window.webkit?.messageHandlers?.wg?.postMessage(m);

const style = document.createElement('style');
style.textContent = styles;
document.head.prepend(style);

let render = 0;
/** Embedded image URL → its asset id, so tapping one opens it. */
let images = new Map<string, number>();

window.wgRender = async (doc) => {
  const seq = ++render;
  const root = document.getElementById('doc')!;
  images = new Map();
  for (const a of Object.values(doc.refs)) if (a?.kind === 'image') images.set(displayUrl(a), a.id);
  root.innerHTML = renderMarkdown(doc.text, doc.refs);
  // Diagrams are drawn after the text is shown.
  void renderDiagrams(root, () => seq === render).catch(() => {});
};

document.addEventListener('click', (e) => {
  const target = e.target as Element;
  const link = target.closest('a');
  const svg = link ? null : target.closest('.md-diagram')?.querySelector('svg');
  if (svg) {
    post({ type: 'diagram', svg: svg.outerHTML });
    return;
  }
  if (link?.hasAttribute(ASSET_LINK_ATTR)) {
    e.preventDefault();
    post({ type: 'asset', id: Number(link.getAttribute(ASSET_LINK_ATTR)) });
    return;
  }
  if (link) {
    const href = link.getAttribute('href') ?? '';
    if (href.startsWith('#')) return; // within the document
    e.preventDefault();
    post({ type: 'link', href: link.href });
    return;
  }
  const img = target.closest('img');
  const id = img && images.get(img.getAttribute('src') ?? '');
  if (id) post({ type: 'asset', id });
});
