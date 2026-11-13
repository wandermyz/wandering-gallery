import { useEffect, useRef, useState } from 'preact/hooks';
import { api, displayUrl, fileUrl, thumbUrl, type Asset, type Query } from './api';
import { IconButton, Spinner } from '../common/ui';
import { cx, formatDate } from '../common/util';

/** Seconds each image stays on screen; a video plays through (looping until at least this long). */
export const SLIDESHOW_INTERVALS = [3, 5, 10, 20, 30];
const INTERVAL_KEY = 'wg.slideshow.interval';
const SHUFFLE_KEY = 'wg.slideshow.shuffle';
const CONTROLS_HIDE_MS = 2800;

/** Images and videos the browser can play; audio and documents are skipped. */
export const inSlideshow = (a: Asset) =>
  a.status === 'ready' && (a.kind === 'image' || (a.kind === 'video' && a.playable !== 'no'));

export interface SlideshowProps {
  items: Asset[];
  /** The first slide (or the first playable one after it). */
  startId: number;
  hasMore: boolean;
  onNeedMore: () => void;
  /** The view's query, for the shuffled order (fetched from the server, all of the view). */
  query: Query;
  /** Narrows the shuffled items like the view (the filename filter). */
  filter?: (a: Asset) => boolean;
  /** Started on an item (from the viewer): shuffled, it still comes first. */
  pinned: boolean;
  /** Leaves the slideshow; `id` is the slide that was showing. */
  onExit: (id: number) => void;
}

function readInterval() {
  const n = Number(localStorage.getItem(INTERVAL_KEY));
  return SLIDESHOW_INTERVALS.includes(n) ? n : 5;
}

/** First slideshow item at or after `from` going `dir`, or -1. */
function seek(items: Asset[], from: number, dir: 1 | -1) {
  for (let i = from; i >= 0 && i < items.length; i += dir) if (inSlideshow(items[i])) return i;
  return -1;
}

/**
 * The view in a random order, page by page (`order=random` with a seed). The slide showing
 * when it's turned on (`head`) stays first.
 */
function useShuffled(query: Query, filter: ((a: Asset) => boolean) | undefined, on: boolean, head: () => Asset | null) {
  const [st, setSt] = useState<{ items: Asset[]; next: string | null; loaded: boolean }>({ items: [], next: null, loaded: false });
  const run = useRef({ gen: 0, seed: 0, loading: false });
  const keep = (list: Asset[]) => (filter ? list.filter(filter) : list);
  useEffect(() => {
    if (!on) return;
    const r = run.current;
    const gen = ++r.gen;
    r.seed = Math.floor(Math.random() * 2 ** 31);
    r.loading = true;
    const first = head();
    setSt({ items: first ? [first] : [], next: null, loaded: false });
    api.assets({ ...query, order: 'random', seed: r.seed }, null, 120)
      .then((page) => {
        if (gen !== r.gen) return;
        const items = keep(page.items).filter((a) => a.id !== first?.id);
        setSt({ items: first ? [first, ...items] : items, next: page.next, loaded: true });
      })
      .catch(() => gen === r.gen && setSt((s) => ({ ...s, loaded: true })))
      .finally(() => { if (gen === r.gen) r.loading = false; });
    return () => { r.gen++; };
  }, [on]);
  const loadMore = () => {
    const r = run.current;
    if (!on || !st.next || r.loading) return;
    const gen = r.gen;
    r.loading = true;
    api.assets({ ...query, order: 'random', seed: r.seed }, st.next, 240)
      .then((page) => {
        if (gen !== r.gen) return;
        setSt((s) => {
          const seen = new Set(s.items.map((a) => a.id));
          return { items: [...s.items, ...keep(page.items).filter((a) => !seen.has(a.id))], next: page.next, loaded: true };
        });
      })
      .catch(() => {})
      .finally(() => { if (gen === r.gen) r.loading = false; });
  };
  return { items: st.items, hasMore: !!st.next, loaded: st.loaded, loadMore };
}

export function Slideshow(props: SlideshowProps) {
  const [shuffle, setShuffle] = useState(() => localStorage.getItem(SHUFFLE_KEY) === '1');
  const [current, setCurrent] = useState<Asset | null>(() => {
    // Shuffled from the gallery, the first slide is a random one (once it's fetched).
    if (shuffle && !props.pinned) return null;
    const list = props.items;
    const at = list.findIndex((a) => a.id === props.startId);
    let i = seek(list, Math.max(0, at), 1);
    if (i < 0) i = seek(list, 0, 1);
    return i >= 0 ? list[i] : null;
  });
  const currentRef = useRef(current);
  currentRef.current = current;
  const shuffled = useShuffled(props.query, props.filter, shuffle, () => currentRef.current);
  // Where the slides come from: the gallery's list as loaded, or the shuffled one.
  const src = shuffle
    ? { items: shuffled.items, hasMore: shuffled.hasMore, onNeedMore: shuffled.loadMore }
    : { items: props.items, hasMore: props.hasMore, onNeedMore: props.onNeedMore };
  const items = src.items;
  const waiting = shuffle && !shuffled.loaded && !current;
  /** The previous slide, kept under the new one while it fades in. */
  const [under, setUnder] = useState<Asset | null>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(true);
  const [interval, setIntervalS] = useState(readInterval);
  const [muted, setMuted] = useState(true);
  const [controls, setControls] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  /** Bumped to restart the progress bar. */
  const [lap, setLap] = useState(0);
  const startedAt = useRef(Date.now());
  const waitingForMore = useRef(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const rootRef = useRef<HTMLDivElement>(null);

  const state = useRef({ props, src, current, playing });
  state.current = { props, src, current, playing };

  const index = current ? items.findIndex((a) => a.id === current.id) : -1;
  // A slide removed from the list meanwhile (moved to trash elsewhere) keeps showing until the next one.
  const lastIndex = useRef(0);
  if (index >= 0) lastIndex.current = index;

  const show = (a: Asset) => {
    const cur = state.current.current;
    if (cur?.id === a.id) {
      // The only slide: restart it.
      startedAt.current = Date.now();
      setLap((n) => n + 1);
      return;
    }
    setUnder(cur);
    setReady(false);
    setCurrent(a);
    startedAt.current = Date.now();
    setLap((n) => n + 1);
  };

  const go = (dir: 1 | -1) => {
    const { src: p, current: cur } = state.current;
    const list = p.items;
    const at = cur ? list.findIndex((a) => a.id === cur.id) : -1;
    const from = at >= 0 ? at + dir : dir === 1 ? lastIndex.current : lastIndex.current - 1;
    const i = seek(list, from, dir);
    if (i >= 0) return show(list[i]);
    if (dir === 1 && p.hasMore) {
      // Wait for the next page, then carry on.
      waitingForMore.current = true;
      p.onNeedMore();
      return;
    }
    // Wrap around (backwards only when the whole list is loaded).
    if (dir === -1 && p.hasMore) return;
    const w = seek(list, dir === 1 ? 0 : list.length - 1, dir);
    if (w >= 0) show(list[w]);
  };

  // Load the next page before reaching the end.
  useEffect(() => {
    if (src.hasMore && index >= items.length - 6) src.onNeedMore();
  }, [index, items.length, src.hasMore, shuffle]);
  useEffect(() => {
    if (!waitingForMore.current) return;
    waitingForMore.current = false;
    go(1);
  }, [items.length, src.hasMore]);
  // Shuffled from the gallery: the first random slide once the first page is in.
  useEffect(() => {
    if (shuffle && shuffled.loaded && !current) {
      const i = seek(items, 0, 1);
      if (i >= 0) show(items[i]);
    }
  }, [shuffled.loaded]);

  const toggleShuffleRef = useRef(() => {});
  const toggleShuffle = () => {
    const on = !shuffle;
    setShuffle(on);
    localStorage.setItem(SHUFFLE_KEY, on ? '1' : '0');
    waitingForMore.current = false;
    // Back in the gallery's order, a slide that isn't in its loaded list continues from the top.
    lastIndex.current = 0;
  };
  toggleShuffleRef.current = toggleShuffle;

  // Fetch the next image ahead, so it can fade in as soon as its turn comes.
  useEffect(() => {
    const i = seek(items, index + 1, 1);
    if (index >= 0 && i >= 0 && items[i].kind === 'image') new Image().src = displayUrl(items[i]);
  }, [index, items]);

  // Images advance on a timer that starts once the image is on screen.
  useEffect(() => {
    if (!playing || !ready || !current || current.kind === 'video') return;
    const t = setTimeout(() => go(1), interval * 1000);
    return () => clearTimeout(t);
  }, [playing, ready, current?.id, interval, lap]);

  const onVideoEnded = (v: HTMLVideoElement) => {
    // A short clip loops until it has had its time on screen.
    if (!state.current.playing || Date.now() - startedAt.current < interval * 1000) {
      v.currentTime = 0;
      void v.play().catch(() => {});
    } else go(1);
  };

  const togglePlay = () => {
    setPlaying((p) => !p);
    startedAt.current = Date.now();
    setLap((n) => n + 1);
  };

  const cycleInterval = () => {
    const next = SLIDESHOW_INTERVALS[(SLIDESHOW_INTERVALS.indexOf(interval) + 1) % SLIDESHOW_INTERVALS.length];
    setIntervalS(next);
    localStorage.setItem(INTERVAL_KEY, String(next));
    startedAt.current = Date.now();
    setLap((n) => n + 1);
  };

  const exit = () => {
    const { props: p, current: cur } = state.current;
    p.onExit(cur?.id ?? p.startId);
  };

  // ---- controls that fade away ---------------------------------------------------

  const poke = () => {
    setControls(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (state.current.playing) setControls(false);
    }, CONTROLS_HIDE_MS);
  };
  useEffect(() => {
    poke();
    return () => clearTimeout(hideTimer.current);
  }, [playing]);

  // ---- keyboard ------------------------------------------------------------------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          exit();
          break;
        case ' ':
        case 'k':
        case 'K':
          e.preventDefault();
          togglePlay();
          poke();
          break;
        case 'ArrowRight':
          e.preventDefault();
          go(1);
          break;
        case 'ArrowLeft':
          e.preventDefault();
          go(-1);
          break;
        case 's':
        case 'S':
          toggleShuffleRef.current();
          break;
        case 'm':
        case 'M':
          setMuted((m) => !m);
          break;
        default:
          return;
      }
      // Keep the page under the slideshow (the viewer, the gallery) from acting on it too.
      e.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // ---- full screen, screen kept awake ------------------------------------------------

  useEffect(() => {
    const el = rootRef.current;
    const sync = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', sync);
    // Desktop browsers go full screen right away (iPhone Safari can't; the slideshow fills the page).
    if (el?.requestFullscreen && matchMedia('(pointer: fine)').matches) el.requestFullscreen().catch(() => {});

    let lock: { release: () => Promise<void> } | null = null;
    let gone = false;
    const wake = () => {
      const wl = (navigator as unknown as { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }).wakeLock;
      wl?.request('screen').then((l) => (gone ? void l.release() : (lock = l))).catch(() => {});
    };
    wake();
    const onVisible = () => document.visibilityState === 'visible' && wake();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      gone = true;
      document.removeEventListener('fullscreenchange', sync);
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release().catch(() => {});
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void rootRef.current?.requestFullscreen?.().catch(() => {});
  };

  // ---- swipes and taps ------------------------------------------------------------------

  const down = useRef<{ x: number; y: number; t: number } | null>(null);
  const onPointerDown = (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest('.ss-bar')) return;
    down.current = { x: e.clientX, y: e.clientY, t: Date.now() };
  };
  const onPointerUp = (e: PointerEvent) => {
    const d = down.current;
    down.current = null;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      go(dx < 0 ? 1 : -1);
      poke();
    } else if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {
      // A tap shows the controls, or hides them when they're up (a mouse just shows them).
      if (controls && e.pointerType !== 'mouse') {
        clearTimeout(hideTimer.current);
        setControls(false);
      } else poke();
    }
  };

  const count = index >= 0 ? `${index + 1}${src.hasMore ? '' : ` / ${items.length}`}` : '';
  const timed = playing && current?.kind === 'image';

  return (
    <div
      ref={rootRef}
      class={cx('slideshow', !controls && 'controls-hidden')}
      role="dialog"
      aria-modal="true"
      aria-label="Slideshow"
      onPointerMove={(e) => e.pointerType === 'mouse' && poke()}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
    >
      {waiting ? (
        <div class="ss-empty"><Spinner /></div>
      ) : !current ? (
        <div class="ss-empty">
          <p>Nothing to show: the slideshow plays images and videos.</p>
          <button type="button" class="btn" onClick={exit}>Close</button>
        </div>
      ) : (
        <>
          {under && under.id !== current.id && <SlideMedia key={`u${under.id}`} asset={under} muted onReady={() => {}} />}
          <SlideMedia
            key={current.id}
            asset={current}
            top
            shown={ready}
            muted={muted}
            onReady={() => setReady(true)}
            onFailed={() => {
              setReady(true);
              // Skip a slide that can't be shown, after a moment.
              if (state.current.playing) setTimeout(() => state.current.current?.id === current.id && go(1), 1200);
            }}
            onFaded={() => setUnder(null)}
            onEnded={onVideoEnded}
          />
          {timed && ready && (
            <div key={`${current.id}-${lap}-${interval}`} class="ss-progress" style={{ animationDuration: `${interval}s` }} />
          )}
        </>
      )}

      <header class="ss-bar ss-top">
        <IconButton icon="close" label="Exit slideshow" onClick={exit} />
        {current && (
          <div class="viewer-title">
            <div class="viewer-name">{current.name}</div>
            <div class="viewer-sub">{formatDate(current.mtimeMs)}</div>
          </div>
        )}
        <span class="viewer-count">{count}</span>
      </header>

      <footer class="ss-bar ss-bottom">
        <IconButton icon="back" label="Previous" onClick={() => go(-1)} />
        <IconButton icon={playing ? 'pause' : 'play'} label={playing ? 'Pause' : 'Play'} class="ss-play" onClick={togglePlay} />
        <IconButton icon="next" label="Next" onClick={() => go(1)} />
        <button type="button" class="btn btn-sm ss-interval" aria-label={`Seconds per slide: ${interval}`} title="Seconds per slide" onClick={cycleInterval}>
          {interval}s
        </button>
        <IconButton
          icon="shuffle"
          label={shuffle ? 'Shuffle on' : 'Shuffle off'}
          active={shuffle}
          aria-pressed={shuffle}
          onClick={toggleShuffle}
        />
        {current?.kind === 'video' && (
          <IconButton icon={muted ? 'mute' : 'volume'} label={muted ? 'Unmute' : 'Mute'} onClick={() => setMuted((m) => !m)} />
        )}
        {document.fullscreenEnabled && (
          <IconButton icon={fullscreen ? 'fullscreen-exit' : 'fullscreen'} label={fullscreen ? 'Exit full screen' : 'Full screen'} onClick={toggleFullscreen} />
        )}
      </footer>
    </div>
  );
}

function SlideMedia({ asset: a, top, shown = true, muted, onReady, onFailed, onFaded, onEnded }: {
  asset: Asset;
  top?: boolean;
  shown?: boolean;
  muted: boolean;
  onReady: () => void;
  onFailed?: () => void;
  onFaded?: () => void;
  onEnded?: (v: HTMLVideoElement) => void;
}) {
  const cls = cx('ss-slide', top && 'ss-top-layer', shown && 'in');
  const faded = (e: TransitionEvent) => e.propertyName === 'opacity' && onFaded?.();
  if (a.kind === 'video') {
    return (
      <div class={cls} onTransitionEnd={faded} data-id={a.id}>
        <video
          class="ss-media"
          src={top ? fileUrl(a) : undefined}
          poster={thumbUrl(a)}
          autoplay={top}
          muted={muted}
          playsinline
          preload="auto"
          onLoadedData={onReady}
          onError={onFailed}
          onEnded={(e) => onEnded?.(e.currentTarget)}
        />
      </div>
    );
  }
  return (
    <div class={cls} onTransitionEnd={faded} data-id={a.id}>
      <img class="ss-media" src={displayUrl(a)} alt={a.name} draggable={false} decoding="async" onLoad={onReady} onError={onFailed} />
    </div>
  );
}
