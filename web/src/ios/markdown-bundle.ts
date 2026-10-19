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
 * (any other link) and `{type: 'diagram', svg}` (a diagram, to zoom into).
 *
 * Videos play with sound when they scroll into view while the page is the viewer's current
 * one (`wgSetActive`), and pause when they leave it. A video the user paused stays paused
 * until it scrolls back into view or the page is shown again.
 */

interface Doc {
  text: string;
  refs: Record<string, Asset | null>;
}

declare global {
  interface Window {
    wgRender(doc: Doc): Promise<void>;
    wgSetActive(active: boolean): void;
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

let active = false;
const inView = new Set<HTMLVideoElement>();

function play(v: HTMLVideoElement) {
  v.muted = false;
  void v.play().catch(() => {});
}

const observer = new IntersectionObserver((entries) => {
  for (const e of entries) {
    const v = e.target as HTMLVideoElement;
    if (e.intersectionRatio >= 0.5) {
      if (!inView.has(v)) {
        inView.add(v);
        if (active) play(v);
      }
    } else if (inView.delete(v)) {
      v.pause();
    }
  }
}, { threshold: [0, 0.5] });

window.wgSetActive = (on) => {
  if (on === active) return;
  active = on;
  for (const v of inView) (on ? play(v) : v.pause());
};

window.wgRender = async (doc) => {
  const seq = ++render;
  const root = document.getElementById('doc')!;
  images = new Map();
  for (const a of Object.values(doc.refs)) if (a?.kind === 'image') images.set(displayUrl(a), a.id);
  observer.disconnect();
  inView.clear();
  root.innerHTML = renderMarkdown(doc.text, doc.refs);
  for (const v of root.querySelectorAll('video')) {
    v.playsInline = true;
    observer.observe(v);
  }
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
