import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { api, displayUrl, fileUrl, thumbUrl, type Asset } from './api';
import { Icon, IconButton, Spinner, Stars } from '../common/ui';
import { InfoPanel } from './InfoPanel';
import { DiagramZoom } from './DiagramZoom';
import { copyText, cx, formatBytes, formatDate, formatDuration, LOCK_EVENT } from '../common/util';

interface Zoom {
  s: number;
  x: number;
  y: number;
}

const MAX_SCALE = 8;
const DOUBLE_TAP_MS = 280;
const SWIPE_FRACTION = 0.18;
const SWIPE_VELOCITY = 0.45; // px/ms

export interface ViewerProps {
  items: Asset[];
  id: number;
  hasMore: boolean;
  onNeedMore: () => void;
  onNavigate: (id: number) => void;
  onClose: () => void;
  onFavorite: (a: Asset) => void;
  onRate: (a: Asset, rating: number) => void;
  onDelete: (a: Asset) => void;
  /** Null when hiding is not set up. */
  onHide: ((a: Asset) => void) | null;
  onShare: (a: Asset) => void;
  /** The asset changed (e.g. its tags were edited in the details panel). */
  onAssetChange: (a: Asset) => void;
  onOpenTag: (name: string) => void;
  /** A document linked to another gallery asset. */
  onOpenAsset: (id: number) => void;
  writable: (a: Asset) => boolean;
}

export function Viewer(props: ViewerProps) {
  const { items, id } = props;
  const index = items.findIndex((a) => a.id === id);
  const asset = items[index];
  const prev = index > 0 ? items[index - 1] : null;
  const next = index >= 0 && index < items.length - 1 ? items[index + 1] : null;

  const [chrome, setChrome] = useState(true);
  const [info, setInfo] = useState(() => localStorage.getItem('wg.info') === '1' && window.innerWidth >= 900);
  const [zoomed, setZoomed] = useState(false);
  const [tagFocus, setTagFocus] = useState(0);
  /** The asset whose path was just copied (or failed to), for the button's feedback. */
  const [copied, setCopied] = useState<{ id: number; ok: boolean } | null>(null);

  const stageRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const zoomElRef = useRef<HTMLDivElement | null>(null);
  const zoom = useRef<Zoom>({ s: 1, x: 0, y: 0 });
  const animating = useRef(false);
  const propsRef = useRef(props);
  propsRef.current = props;
  const navRef = useRef({ prev, next, asset });
  navRef.current = { prev, next, asset };

  useEffect(() => {
    if (props.hasMore && index >= items.length - 6) props.onNeedMore();
  }, [index, items.length, props.hasMore]);

  // ---- zoom helpers ------------------------------------------------------------

  const stageSize = () => {
    const r = stageRef.current!.getBoundingClientRect();
    return { w: r.width, h: r.height, left: r.left, top: r.top };
  };

  /**
   * Displayed size of the current image at scale 1 (fitted to its box, which sits between the
   * bars), and its centre's offset from the stage's centre.
   */
  const contentSize = () => {
    const { w, h } = stageSize();
    const img = zoomElRef.current?.querySelector('img.full, img.ph') as HTMLImageElement | null;
    // offset* ignore the zoom transform.
    const bw = img?.offsetWidth || w;
    const bh = img?.offsetHeight || h;
    const oy = img ? img.offsetTop + bh / 2 - h / 2 : 0;
    const a = navRef.current.asset;
    const nw = a?.width || img?.naturalWidth || w;
    const nh = a?.height || img?.naturalHeight || h;
    const fit = Math.min(bw / nw, bh / nh);
    return { cw: nw * fit, ch: nh * fit, w, h, oy };
  };

  const clampZoom = (z: Zoom): Zoom => {
    const s = Math.min(MAX_SCALE, Math.max(1, z.s));
    const { cw, ch, w, h, oy } = contentSize();
    const mx = Math.max(0, (cw * s - w) / 2);
    // Vertically the image sits off the stage's centre (by oy, scaled with it). Taller than the
    // stage, it pans until an edge reaches the stage's; shorter, it stays put unless that would
    // take it past the stage's edge.
    const my = Math.abs(ch * s - h) / 2;
    const y = Math.min(my - oy * s, Math.max(-my - oy * s, ch * s > h ? z.y : 0));
    return { s, x: Math.min(mx, Math.max(-mx, z.x)), y };
  };

  const applyZoom = (z: Zoom, animate = false) => {
    zoom.current = z;
    const el = zoomElRef.current;
    if (el) {
      el.style.transition = animate ? 'transform 220ms cubic-bezier(.2,.8,.2,1)' : 'none';
      el.style.transform = z.s === 1 && z.x === 0 && z.y === 0 ? '' : `translate3d(${z.x}px, ${z.y}px, 0) scale(${z.s})`;
    }
    const isZoomed = z.s > 1.01;
    setZoomed((prevZ) => (prevZ === isZoomed ? prevZ : isZoomed));
  };

  const zoomAt = (px: number, py: number, s: number, animate = true) => {
    // px/py are relative to the stage centre.
    const z = zoom.current;
    const cx = (px - z.x) / z.s;
    const cy = (py - z.y) / z.s;
    applyZoom(clampZoom({ s, x: px - cx * s, y: py - cy * s }), animate);
  };

  const resetZoom = (animate = false) => applyZoom({ s: 1, x: 0, y: 0 }, animate);

  // Reset zoom whenever the asset changes.
  useLayoutEffect(() => {
    zoom.current = { s: 1, x: 0, y: 0 };
    if (zoomElRef.current) zoomElRef.current.style.transform = '';
    setZoomed(false);
  }, [id]);

  // ---- slide navigation -------------------------------------------------------------

  const setTrack = (dx: number, animate: boolean) => {
    const t = trackRef.current;
    if (!t) return;
    t.style.transition = animate ? 'transform 240ms cubic-bezier(.2,.8,.2,1)' : 'none';
    t.style.transform = `translate3d(${dx}px,0,0)`;
  };

  const go = useCallback((dir: -1 | 1) => {
    const target = dir < 0 ? navRef.current.prev : navRef.current.next;
    if (!target || animating.current) {
      setTrack(0, true);
      return;
    }
    animating.current = true;
    const { w } = stageSize();
    setTrack(-dir * w, true);
    const done = () => {
      animating.current = false;
      // The viewer may have closed mid-slide (e.g. iOS edge-swipe back): navigating now
      // would rewrite the grid's history entry into a viewer one.
      if (!trackRef.current?.isConnected) return;
      setTrack(0, false);
      propsRef.current.onNavigate(target.id);
    };
    const t = trackRef.current!;
    const fallback = setTimeout(done, 320);
    t.addEventListener('transitionend', () => {
      clearTimeout(fallback);
      done();
    }, { once: true });
  }, []);

  // ---- keyboard -------------------------------------------------------------------------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      const a = navRef.current.asset;
      const p = propsRef.current;
      switch (e.key) {
        case 'ArrowLeft':
          if (zoom.current.s > 1.01) return;
          e.preventDefault();
          go(-1);
          break;
        case 'ArrowRight':
          if (zoom.current.s > 1.01) return;
          e.preventDefault();
          go(1);
          break;
        case 'Escape':
          e.preventDefault();
          if (zoom.current.s > 1.01) resetZoom(true);
          else p.onClose();
          break;
        case 'f':
        case 'F':
          if (a) p.onFavorite(a);
          break;
        case 'i':
        case 'I':
          setInfo((v) => !v);
          break;
        case 't':
        case 'T':
          // Opens the details with the tag input focused.
          if (a?.status === 'ready') {
            e.preventDefault();
            setInfo(true);
            setTagFocus((n) => n + 1);
          }
          break;
        case 'Delete':
        case 'Backspace':
          if (a && p.writable(a)) {
            e.preventDefault();
            p.onDelete(a);
          }
          break;
        case '+':
        case '=':
          zoomAt(0, 0, zoom.current.s * 1.5);
          break;
        case '-':
          zoomAt(0, 0, zoom.current.s / 1.5);
          break;
        default:
          if (/^[0-5]$/.test(e.key) && a) p.onRate(a, Number(e.key));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    localStorage.setItem('wg.info', info ? '1' : '0');
  }, [info]);

  // ---- pointer gestures ---------------------------------------------------------------------

  // Re-attached once the stage exists: a deep-linked asset may render the empty state first.
  const hasStage = !!asset;
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const pts = new Map<number, { x: number; y: number }>();
    let mode: 'none' | 'pending' | 'swipe' | 'dismiss' | 'pan' | 'pinch' = 'none';
    let start = { x: 0, y: 0, t: 0 };
    let startZoom: Zoom = { s: 1, x: 0, y: 0 };
    let pinchStart = { dist: 1, mx: 0, my: 0 };
    let lastTap = { t: 0, x: 0, y: 0 };
    let tapTimer: ReturnType<typeof setTimeout> | null = null;
    let moved = false;
    let last = { x: 0, y: 0, t: 0 };
    let velocity = 0;

    const rel = (x: number, y: number) => {
      const s = stageSize();
      return { x: x - s.left - s.w / 2, y: y - s.top - s.h / 2 };
    };
    // Native controls sit along the top (iOS: fullscreen, mute) and bottom (scrubber) edges of
    // the video's content box, inside the padding that keeps them clear of our bars.
    const isVideoControls = (e: PointerEvent) => {
      const v = (e.target as HTMLElement).closest('video');
      if (!v) return false;
      const r = v.getBoundingClientRect();
      const cs = getComputedStyle(v);
      const top = r.top + parseFloat(cs.paddingTop);
      const bottom = r.bottom - parseFloat(cs.paddingBottom);
      return e.clientY < top + 56 || e.clientY > bottom - 72;
    };
    const interactive = (e: PointerEvent) => !!(e.target as HTMLElement).closest('button, a, input, .no-gesture');

    const down = (e: PointerEvent) => {
      if (interactive(e) || isVideoControls(e) || animating.current) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      // A mouse selects text in a document (capturing the pointer would stop that).
      if (e.pointerType === 'mouse' && (e.target as HTMLElement).closest('.md-scroll')) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try {
        stage.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      if (pts.size === 1) {
        start = { x: e.clientX, y: e.clientY, t: performance.now() };
        last = { ...start };
        velocity = 0;
        startZoom = { ...zoom.current };
        moved = false;
        mode = 'pending';
      } else if (pts.size === 2 && navRef.current.asset?.kind === 'image') {
        const [a, b] = [...pts.values()];
        const m = rel((a.x + b.x) / 2, (a.y + b.y) / 2);
        pinchStart = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: m.x, my: m.y };
        startZoom = { ...zoom.current };
        setTrack(0, true);
        mode = 'pinch';
        moved = true;
      }
    };

    const move = (e: PointerEvent) => {
      const p = pts.get(e.pointerId);
      if (!p) return;
      p.x = e.clientX;
      p.y = e.clientY;
      const now = performance.now();
      if (now > last.t) velocity = (e.clientX - last.x) / (now - last.t);
      last = { x: e.clientX, y: e.clientY, t: now };
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;

      if (mode === 'pinch' && pts.size >= 2) {
        const [a, b] = [...pts.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const m = rel((a.x + b.x) / 2, (a.y + b.y) / 2);
        const s = Math.min(MAX_SCALE * 1.2, Math.max(0.6, (startZoom.s * dist) / pinchStart.dist));
        const cx = (pinchStart.mx - startZoom.x) / startZoom.s;
        const cy = (pinchStart.my - startZoom.y) / startZoom.s;
        applyZoom({ s, x: m.x - cx * s, y: m.y - cy * s });
        return;
      }
      if (mode === 'pending') {
        if (Math.hypot(dx, dy) < 8) return;
        moved = true;
        if (startZoom.s > 1.01) mode = 'pan';
        else if (e.pointerType === 'mouse') mode = 'none';
        // Documents scroll vertically (natively); only a horizontal swipe moves on.
        else if ((e.target as HTMLElement).closest('.md-scroll')) mode = Math.abs(dx) > Math.abs(dy) * 1.5 ? 'swipe' : 'none';
        else if (Math.abs(dx) > Math.abs(dy)) mode = 'swipe';
        else if (dy > 0) mode = 'dismiss';
        else mode = 'none';
      }
      if (mode === 'pan') {
        const z = clampZoom({ s: startZoom.s, x: startZoom.x + dx, y: startZoom.y + dy });
        // Rubber-band slightly past the edges.
        const over = (v: number, c: number) => c + (v - c) * 0.3;
        applyZoom({ s: z.s, x: over(startZoom.x + dx, z.x), y: over(startZoom.y + dy, z.y) });
      } else if (mode === 'swipe') {
        const { prev: pv, next: nx } = navRef.current;
        const resist = (dx > 0 && !pv) || (dx < 0 && !nx) ? 0.3 : 1;
        setTrack(dx * resist, false);
      } else if (mode === 'dismiss') {
        const t = trackRef.current!;
        t.style.transition = 'none';
        t.style.transform = `translate3d(0, ${dy}px, 0) scale(${1 - Math.min(0.25, dy / 1600)})`;
        stage.parentElement!.style.setProperty('--bg-alpha', String(Math.max(0.2, 1 - dy / 500)));
      }
    };

    const up = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      // The browser took the touch over (iOS edge-swipe back, scrolling…): never commit a
      // swipe or dismiss from it, or we'd navigate/close on top of the browser's own navigation.
      if (e.type === 'pointercancel' && (mode === 'swipe' || mode === 'dismiss')) {
        if (pts.size > 0) return;
        setTrack(0, true);
        stage.parentElement!.style.removeProperty('--bg-alpha');
        mode = 'none';
        return;
      }
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (mode === 'pinch') {
        if (pts.size === 1) {
          // Continue as a pan with the remaining finger.
          const [r] = [...pts.values()];
          start = { x: r.x, y: r.y, t: performance.now() };
          startZoom = { ...zoom.current };
          mode = 'pan';
          return;
        }
        if (zoom.current.s < 1.05) resetZoom(true);
        else applyZoom(clampZoom(zoom.current), true);
        mode = 'none';
        return;
      }
      if (pts.size > 0) return;
      if (mode === 'pan') {
        applyZoom(clampZoom(zoom.current), true);
      } else if (mode === 'swipe') {
        const { w } = stageSize();
        if ((dx < -w * SWIPE_FRACTION || velocity < -SWIPE_VELOCITY) && navRef.current.next) go(1);
        else if ((dx > w * SWIPE_FRACTION || velocity > SWIPE_VELOCITY) && navRef.current.prev) go(-1);
        else setTrack(0, true);
      } else if (mode === 'dismiss') {
        const t = trackRef.current!;
        if (dy > 120) {
          propsRef.current.onClose();
        } else {
          t.style.transition = 'transform 200ms ease';
          t.style.transform = 'translate3d(0,0,0)';
          stage.parentElement!.style.removeProperty('--bg-alpha');
        }
      } else if (!moved && e.type === 'pointerup') {
        handleTap(e);
      }
      mode = 'none';
    };

    const handleTap = (e: PointerEvent) => {
      const now = performance.now();
      const isImage = navRef.current.asset?.kind === 'image';
      const onVideo = !!(e.target as HTMLElement).closest('video');
      if (isImage && now - lastTap.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
        if (tapTimer) clearTimeout(tapTimer);
        tapTimer = null;
        lastTap = { t: 0, x: 0, y: 0 };
        if (zoom.current.s > 1.01) resetZoom(true);
        else {
          const { cw, ch, w, h } = contentSize();
          // Zoom to fill the screen, at least 2.5x.
          const fill = Math.max(w / cw, h / ch);
          const p = rel(e.clientX, e.clientY);
          zoomAt(p.x, p.y, Math.min(MAX_SCALE, Math.max(2.5, fill)));
        }
        return;
      }
      lastTap = { t: now, x: e.clientX, y: e.clientY };
      if (onVideo) return; // let native video tap behaviour work
      if ((e.target as HTMLElement).closest('.md-diagram')) return; // it opens full screen
      if (tapTimer) clearTimeout(tapTimer);
      tapTimer = setTimeout(() => {
        tapTimer = null;
        setChrome((c) => !c);
      }, isImage ? DOUBLE_TAP_MS : 0);
    };

    const wheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest('.no-gesture')) return;
      if (navRef.current.asset?.kind !== 'image') return;
      e.preventDefault();
      const p = rel(e.clientX, e.clientY);
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0025));
      zoomAt(p.x, p.y, zoom.current.s * factor, false);
      if (zoom.current.s < 1.01) resetZoom(false);
    };

    // Safari-specific gesture events would otherwise zoom the whole page.
    const prevent = (e: Event) => e.preventDefault();

    stage.addEventListener('pointerdown', down);
    stage.addEventListener('pointermove', move);
    stage.addEventListener('pointerup', up);
    stage.addEventListener('pointercancel', up);
    stage.addEventListener('wheel', wheel, { passive: false });
    stage.addEventListener('gesturestart', prevent);
    stage.addEventListener('gesturechange', prevent);
    return () => {
      stage.removeEventListener('pointerdown', down);
      stage.removeEventListener('pointermove', move);
      stage.removeEventListener('pointerup', up);
      stage.removeEventListener('pointercancel', up);
      stage.removeEventListener('wheel', wheel);
      stage.removeEventListener('gesturestart', prevent);
      stage.removeEventListener('gesturechange', prevent);
      if (tapTimer) clearTimeout(tapTimer);
    };
  }, [go, hasStage]);

  // Clear dismiss-gesture styling when switching assets.
  useLayoutEffect(() => {
    const t = trackRef.current;
    if (t) {
      t.style.transition = 'none';
      t.style.transform = 'translate3d(0,0,0)';
    }
    stageRef.current?.parentElement?.style.removeProperty('--bg-alpha');
  }, [id]);

  if (!asset) {
    return (
      <div class="viewer">
        <div class="viewer-empty">
          <p>This item is no longer available.</p>
          <button type="button" class="btn" onClick={props.onClose}>Back to gallery</button>
        </div>
      </div>
    );
  }

  const writable = props.writable(asset);

  return (
    <div class={cx('viewer', !chrome && 'chrome-hidden', info && 'info-open', zoomed && 'zoomed', asset.kind === 'markdown' && 'doc')} role="dialog" aria-modal="true" aria-label={asset.name}>
      <div class="viewer-main">
        <div class="stage" ref={stageRef}>
          <div class="track" ref={trackRef}>
            {prev && <Slide key={prev.id} asset={prev} pos={-1} active={false} />}
            <Slide key={asset.id} asset={asset} pos={0} active zoomRef={(el) => (zoomElRef.current = el)} onOpenAsset={props.onOpenAsset} />
            {next && <Slide key={next.id} asset={next} pos={1} active={false} />}
          </div>
        </div>

        <header class="viewer-top">
          <IconButton icon="back" label="Back to gallery" onClick={props.onClose} />
          <div class="viewer-title">
            <div class="viewer-name" title={asset.path}>{asset.name}</div>
            <div class="viewer-sub">
              {formatDate(asset.mtimeMs)}
              {asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : ''}
              {(asset.kind === 'video' || asset.kind === 'audio') && asset.duration ? ` · ${formatDuration(asset.duration)}` : ''}
              {` · ${formatBytes(asset.size)}`}
            </div>
          </div>
          {asset.filePath && (
            <IconButton
              icon={copied?.id === asset.id ? (copied.ok ? 'check' : 'alert') : 'copy'}
              label={copied?.id === asset.id ? (copied.ok ? 'Path copied' : 'Could not copy') : 'Copy path'}
              active={copied?.id === asset.id && copied.ok}
              onClick={async () => {
                const ok = await copyText(asset.filePath!);
                setCopied({ id: asset.id, ok });
                setTimeout(() => setCopied((c) => (c?.id === asset.id ? null : c)), 1600);
              }}
            />
          )}
          <span class="viewer-count">{index + 1}{props.hasMore ? '' : ` / ${items.length}`}</span>
        </header>

        {prev && <button type="button" class="nav-arrow left" aria-label="Previous" onClick={() => go(-1)}><Icon name="back" size={28} /></button>}
        {next && <button type="button" class="nav-arrow right" aria-label="Next" onClick={() => go(1)}><Icon name="next" size={28} /></button>}

        <footer class="viewer-bottom">
          <IconButton
            icon="heart"
            label={asset.favorite ? 'Remove from favorites' : 'Add to favorites'}
            filled={asset.favorite}
            active={asset.favorite}
            class="fav-btn"
            onClick={() => props.onFavorite(asset)}
          />
          <Stars value={asset.rating} onChange={(r) => props.onRate(asset, r)} size={26} />
          <IconButton icon="share" label="Share or save original" onClick={() => props.onShare(asset)} />
          <IconButton icon="info" label="Details and metadata" active={info} onClick={() => setInfo((v) => !v)} />
          {props.onHide && (
            <IconButton
              icon={asset.hidden ? 'eye' : 'eye-off'}
              label={asset.hidden ? 'Unhide' : 'Hide'}
              active={asset.hidden}
              onClick={() => props.onHide!(asset)}
            />
          )}
          <IconButton
            icon="trash"
            label={writable ? 'Move to trash' : 'Library is read-only'}
            disabled={!writable}
            onClick={() => props.onDelete(asset)}
          />
        </footer>
      </div>
      {info && (
        <InfoPanel asset={asset} onClose={() => setInfo(false)} onAssetChange={props.onAssetChange} onOpenTag={props.onOpenTag} tagFocus={tagFocus} />
      )}
    </div>
  );
}

function Slide({ asset: a, pos, active, zoomRef, onOpenAsset }: {
  asset: Asset; pos: number; active: boolean; zoomRef?: (el: HTMLDivElement | null) => void; onOpenAsset?: (id: number) => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const style = { transform: `translate3d(${pos * 100}%,0,0)` };
  const cls = cx('slide', active && 'active');

  if (a.kind === 'markdown') {
    return (
      <div class={cx(cls, 'slide-doc')} style={style}>
        {active ? <MarkdownDoc asset={a} onOpenAsset={onOpenAsset} /> : <img class="media ph" src={thumbUrl(a)} alt="" draggable={false} />}
      </div>
    );
  }

  if (a.kind === 'audio') {
    const unsupported = a.playable === 'no' || failed;
    return (
      <div class={cx(cls, 'slide-audio')} style={style}>
        <img class="media ph audio-art" src={thumbUrl(a)} alt="" draggable={false} />
        {active && !unsupported && (
          <div class="audio-player no-gesture">
            <audio key={a.id} src={fileUrl(a)} controls preload="metadata" onError={() => setFailed(true)} />
          </div>
        )}
        {active && unsupported && (
          <div class="media-msg no-gesture">
            <Icon name="alert" size={28} />
            <p>
              This browser can't play this audio
              {a.audioCodec ? <> (codec: <code>{a.audioCodec}</code>)</> : null}.
            </p>
            <p class="muted">The original file is unchanged. Download it to play it in another app.</p>
            <a class="btn" href={`${fileUrl(a)}&download=1`} download={a.name}>
              <Icon name="download" size={18} /> Download
            </a>
          </div>
        )}
      </div>
    );
  }

  if (a.kind === 'video') {
    const unsupported = a.playable === 'no' || failed;
    return (
      <div class={cls} style={style}>
        {active && !unsupported ? (
          <video
            key={a.id}
            class="media"
            src={fileUrl(a)}
            poster={thumbUrl(a)}
            controls
            autoplay
            muted
            loop
            playsinline
            preload="metadata"
            onError={() => setFailed(true)}
          />
        ) : (
          <img class="media ph" src={thumbUrl(a)} alt="" draggable={false} />
        )}
        {active && unsupported && (
          <div class="media-msg no-gesture">
            <Icon name="alert" size={28} />
            <p>
              This browser can't play this video
              {a.videoCodec ? <> (codec: <code>{a.videoCodec}</code>)</> : null}.
            </p>
            <p class="muted">The original file is unchanged. Download it to play it in another app.</p>
            <a class="btn" href={`${fileUrl(a)}&download=1`} download={a.name}>
              <Icon name="download" size={18} /> Download
            </a>
          </div>
        )}
        {active && a.playable === 'partial' && !failed && (
          <div class="media-hint">{a.videoCodec?.toUpperCase()} may not play in every browser.</div>
        )}
      </div>
    );
  }

  return (
    <div class={cls} style={style}>
      <div class="zoom" ref={zoomRef}>
        <img class={cx('media ph', loaded && 'hidden')} src={thumbUrl(a)} alt="" draggable={false} />
        {!failed && (
          <img
            class={cx('media full', loaded && 'shown')}
            src={displayUrl(a)}
            alt={a.name}
            draggable={false}
            decoding="async"
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
          />
        )}
      </div>
      {active && !loaded && !failed && <div class="slide-loading"><Spinner /></div>}
      {active && failed && (
        <div class="media-msg no-gesture">
          <Icon name="alert" size={28} />
          <p>This image could not be displayed.</p>
          <a class="btn" href={`${fileUrl(a)}&download=1`} download={a.name}>
            <Icon name="download" size={18} /> Download original
          </a>
        </div>
      )}
    </div>
  );
}

type Renderer = typeof import('./markdown');
let renderer: Promise<Renderer> | null = null;

/**
 * A rendered Markdown document. Its embedded images and videos are gallery assets
 * resolved by the server, so it is fetched again whenever the lock changes.
 */
function MarkdownDoc({ asset: a, onOpenAsset }: { asset: Asset; onOpenAsset?: (id: number) => void }) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lockRev, setLockRev] = useState(0);
  const [diagram, setDiagram] = useState<SVGSVGElement | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const docRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const on = () => setLockRev((n) => n + 1);
    window.addEventListener(LOCK_EVENT, on);
    return () => window.removeEventListener(LOCK_EVENT, on);
  }, []);

  useEffect(() => {
    let alive = true;
    setError(null);
    if (!lockRev) setHtml(null);
    renderer ??= import('./markdown');
    Promise.all([api.markdown(a.id), renderer]).then(
      ([doc, r]) => alive && setHtml(r.renderMarkdown(doc.text, doc.refs)),
      (e) => {
        if (!alive) return;
        setHtml(null);
        setError((e as Error).message);
      },
    );
    return () => {
      alive = false;
    };
  }, [a.id, a.v, lockRev]);

  // Diagrams are drawn into the rendered HTML; a new render starts over from the source.
  useEffect(() => {
    setDiagram(null);
    const el = docRef.current;
    if (html === null || !el || !renderer) return;
    let alive = true;
    renderer.then((r) => r.renderDiagrams(el, () => alive)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [html]);

  // Keyboard scrolling (space, page and arrow keys up/down) works once it has focus.
  useEffect(() => {
    if (html !== null && !lockRev) scrollRef.current?.focus({ preventScroll: true });
  }, [html !== null]);

  const onClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    // A diagram opens full screen, to zoom into it (unless its own link was tapped).
    const svg = target.closest('a') ? null : target.closest('.md-diagram')?.querySelector('svg');
    if (svg) {
      setDiagram(svg);
      return;
    }
    const link = target.closest('a[data-asset]');
    if (!link) return;
    e.preventDefault();
    onOpenAsset?.(Number(link.getAttribute('data-asset')));
  };

  if (error) {
    return (
      <div class="media-msg no-gesture">
        <Icon name="alert" size={28} />
        <p>This document could not be displayed: {error}</p>
        <a class="btn" href={`${fileUrl(a)}&download=1`} download={a.name}>
          <Icon name="download" size={18} /> Download
        </a>
      </div>
    );
  }
  if (html === null) return <div class="slide-loading"><Spinner /></div>;
  return (
    <div class="md-scroll" ref={scrollRef} tabIndex={-1} onClick={onClick}>
      <article class="md" ref={docRef} dangerouslySetInnerHTML={{ __html: html }} />
      {diagram && <DiagramZoom svg={diagram} onClose={() => setDiagram(null)} />}
    </div>
  );
}
