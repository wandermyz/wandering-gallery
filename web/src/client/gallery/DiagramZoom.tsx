import { createPortal } from 'preact/compat';
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { IconButton } from '../common/ui';

interface View {
  s: number;
  x: number;
  y: number;
}

const DOUBLE_TAP_MS = 280;

/**
 * A diagram from a document, full screen: pinch, wheel or +/- to zoom, drag to pan,
 * double-tap to toggle between fit and 2.5x. Shown over the viewer (outside its stage,
 * so the viewer's swipe gestures and keys don't apply).
 */
export function DiagramZoom({ svg, onClose }: { svg: SVGSVGElement; onClose: () => void }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const view = useRef<View>({ s: 1, x: 0, y: 0 });
  const size = useRef({ w: 1, h: 1 });
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const apply = (v: View, animate = false) => {
    view.current = v;
    const el = contentRef.current;
    if (!el) return;
    el.style.transition = animate ? 'transform 200ms cubic-bezier(.2,.8,.2,1)' : 'none';
    el.style.transform = `translate(${v.x}px,${v.y}px) scale(${v.s})`;
  };
  const box = () => boxRef.current!.getBoundingClientRect();
  const fitScale = () => {
    const b = box();
    return Math.min((b.width * 0.94) / size.current.w, (b.height * 0.94) / size.current.h);
  };
  const fit = (animate = false) => {
    const b = box();
    const s = fitScale();
    apply({ s, x: (b.width - s * size.current.w) / 2, y: (b.height - s * size.current.h) / 2 }, animate);
  };
  const limit = (s: number) => {
    const f = fitScale();
    return Math.min(Math.max(f, 1) * 10, Math.max(f * 0.5, s));
  };
  /** Zoom to scale `s` keeping the point (px, py) of the box in place. */
  const zoomAt = (px: number, py: number, s: number, animate = false) => {
    const v = view.current;
    const ns = limit(s);
    apply({ s: ns, x: px - ((px - v.x) * ns) / v.s, y: py - ((py - v.y) * ns) / v.s }, animate);
  };
  const zoomCenter = (factor: number) => {
    const b = box();
    zoomAt(b.width / 2, b.height / 2, view.current.s * factor, true);
  };

  // A copy of the diagram at its natural size; the copy is scaled, so it stays sharp.
  useLayoutEffect(() => {
    const el = contentRef.current!;
    const copy = svg.cloneNode(true) as SVGSVGElement;
    const vb = svg.viewBox.baseVal;
    const r = svg.getBoundingClientRect();
    const w = vb && vb.width ? vb.width : r.width || 300;
    const h = vb && vb.height ? vb.height : r.height || 150;
    size.current = { w, h };
    // Its own size, not the document's; the style also holds the diagram's colors and fonts.
    copy.style.removeProperty('max-width');
    copy.style.removeProperty('height');
    copy.setAttribute('width', String(w));
    copy.setAttribute('height', String(h));
    el.replaceChildren(copy);
    fit();
  }, [svg]);

  useEffect(() => {
    const el = boxRef.current!;
    const pts = new Map<number, { x: number; y: number }>();
    let start: { v: View; dist: number; mx: number; my: number } | null = null;
    let lastTap = { t: 0, x: 0, y: 0 };
    let moved = false;
    const rel = (x: number, y: number) => {
      const b = box();
      return { x: x - b.left, y: y - b.top };
    };
    // (Re)starts the gesture from the current pointers, so adding or lifting a finger doesn't jump.
    const begin = () => {
      const p = [...pts.values()];
      const mx = p.reduce((n, q) => n + q.x, 0) / p.length;
      const my = p.reduce((n, q) => n + q.y, 0) / p.length;
      const dist = p.length > 1 ? Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) || 1 : 1;
      const m = rel(mx, my);
      start = { v: { ...view.current }, dist, mx: m.x, my: m.y };
    };
    const down = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest('button')) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      el.setPointerCapture(e.pointerId);
      if (pts.size === 1) moved = false;
      begin();
    };
    const move = (e: PointerEvent) => {
      const p = pts.get(e.pointerId);
      if (!p || !start) return;
      p.x = e.clientX;
      p.y = e.clientY;
      const q = [...pts.values()];
      const m = rel(q.reduce((n, r) => n + r.x, 0) / q.length, q.reduce((n, r) => n + r.y, 0) / q.length);
      if (!moved && Math.hypot(m.x - start.mx, m.y - start.my) < 6 && q.length < 2) return;
      moved = true;
      const s = q.length > 1 ? limit((start.v.s * Math.hypot(q[0].x - q[1].x, q[0].y - q[1].y)) / start.dist) : start.v.s;
      const cx = (start.mx - start.v.x) / start.v.s;
      const cy = (start.my - start.v.y) / start.v.s;
      apply({ s, x: m.x - cx * s, y: m.y - cy * s });
    };
    const up = (e: PointerEvent) => {
      if (!pts.delete(e.pointerId)) return;
      if (pts.size) {
        begin();
        return;
      }
      start = null;
      if (moved || e.type !== 'pointerup') return;
      const now = performance.now();
      if (now - lastTap.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
        lastTap = { t: 0, x: 0, y: 0 };
        const f = fitScale();
        if (view.current.s > f * 1.2) fit(true);
        else {
          const p = rel(e.clientX, e.clientY);
          zoomAt(p.x, p.y, Math.max(2.5, f * 2.5), true);
        }
      } else lastTap = { t: now, x: e.clientX, y: e.clientY };
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = rel(e.clientX, e.clientY);
      zoomAt(p.x, p.y, view.current.s * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025)));
    };
    // Captured first, so the viewer underneath doesn't also close or move on.
    const key = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key;
      if (k === 'Escape') onCloseRef.current();
      else if (k === '+' || k === '=') zoomCenter(1.5);
      else if (k === '-') zoomCenter(1 / 1.5);
      else if (k === '0') fit(true);
      else if (!k.startsWith('Arrow') && k !== 'Delete' && k !== 'Backspace' && !/^[1-5fFiItT]$/.test(k)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    const resize = () => fit();
    const prevent = (e: Event) => e.preventDefault();
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('gesturestart', prevent);
    el.addEventListener('gesturechange', prevent);
    window.addEventListener('keydown', key, true);
    window.addEventListener('resize', resize);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('gesturestart', prevent);
      el.removeEventListener('gesturechange', prevent);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return createPortal(
    <div class="diagram-zoom" role="dialog" aria-modal="true" aria-label="Diagram">
      <div class="diagram-zoom-box" ref={boxRef}>
        <div class="diagram-zoom-content" ref={contentRef} />
      </div>
      <div class="diagram-zoom-bar">
        <IconButton icon="minus" label="Zoom out" onClick={() => zoomCenter(1 / 1.5)} />
        <button type="button" class="diagram-zoom-fit" onClick={() => fit(true)}>Fit</button>
        <IconButton icon="plus" label="Zoom in" onClick={() => zoomCenter(1.5)} />
        <IconButton icon="close" label="Close diagram" onClick={onClose} />
      </div>
    </div>,
    document.body,
  );
}
