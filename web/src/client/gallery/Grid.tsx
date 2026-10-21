import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { thumbUrl, type Asset } from './api';
import { Icon, MiniRating } from '../common/ui';
import { CAPTION_LABELS, cx, dayLabel, formatDuration } from '../common/util';

type Row =
  | { type: 'h'; top: number; label: string; key: string }
  | { type: 'r'; top: number; start: number; end: number; key: string };

export const DENSITY_TARGET = { s: 92, m: 128, l: 200 } as const;
export type Density = keyof typeof DENSITY_TARGET;

const GAP = 2;
const HEADER_H = 40;

function dayKey(ms: number) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * Virtualised, window-scrolled thumbnail grid with optional day headers. Only
 * rows near the viewport are rendered, so tens of thousands of items stay smooth.
 */
export function Grid({ items, density, groupByDay, hasMore, onNeedMore, onOpen, focusId, selected, onSelect }: {
  items: Asset[];
  density: Density;
  groupByDay: boolean;
  hasMore: boolean;
  onNeedMore: () => void;
  onOpen: (index: number) => void;
  /** When set, scroll so this asset is visible (used when returning from the viewer). */
  focusId: number | null;
  /** The selected asset ids while selecting (a tap toggles instead of opening), else null. */
  selected: Set<number> | null;
  /** Toggles an item: a tap while selecting, or a long press (which starts selecting). `range`: shift-click. */
  onSelect: (index: number, range: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [view, setView] = useState({ top: 0, height: typeof window !== 'undefined' ? window.innerHeight : 800 });

  useLayoutEffect(() => {
    const el = ref.current!;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let raf = 0;
    const update = () => {
      raf = 0;
      const el = ref.current;
      if (!el) return;
      const offset = el.getBoundingClientRect().top + window.scrollY;
      setView({ top: window.scrollY - offset, height: window.innerHeight });
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  const cols = Math.max(2, Math.round((width + GAP) / (DENSITY_TARGET[density] + GAP)));
  const cell = width ? (width - GAP * (cols - 1)) / cols : 0;

  const { rows, height, rowOf } = useMemo(() => {
    const rows: Row[] = [];
    const rowOf = new Map<number, number>();
    let top = 0;
    let i = 0;
    while (i < items.length) {
      if (groupByDay) {
        const k = dayKey(items[i].mtimeMs);
        rows.push({ type: 'h', top, label: dayLabel(items[i].mtimeMs), key: `h${k}` });
        top += HEADER_H;
        let end = i;
        while (end < items.length && dayKey(items[end].mtimeMs) === k) end++;
        for (let s = i; s < end; s += cols) {
          const e = Math.min(end, s + cols);
          for (let j = s; j < e; j++) rowOf.set(items[j].id, rows.length);
          rows.push({ type: 'r', top, start: s, end: e, key: `r${items[s].id}` });
          top += cell + GAP;
        }
        i = end;
      } else {
        const e = Math.min(items.length, i + cols);
        for (let j = i; j < e; j++) rowOf.set(items[j].id, rows.length);
        rows.push({ type: 'r', top, start: i, end: e, key: `r${items[i].id}` });
        top += cell + GAP;
        i = e;
      }
    }
    return { rows, height: top, rowOf };
  }, [items, cols, cell, groupByDay]);

  // Visible window with generous overscan.
  const overscan = view.height;
  const from = view.top - overscan;
  const to = view.top + view.height + overscan;
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const r = rows[mid];
    const bottom = r.top + (r.type === 'h' ? HEADER_H : cell);
    if (bottom < from) lo = mid + 1;
    else hi = mid;
  }
  const visible: Row[] = [];
  for (let k = lo; k < rows.length && rows[k].top <= to; k++) visible.push(rows[k]);

  // Infinite loading: ask for more when the viewport nears the end of loaded rows.
  const nearEnd = view.top + view.height * 2.5 >= height;
  useEffect(() => {
    if (hasMore && nearEnd && width) onNeedMore();
  }, [hasMore, nearEnd, width, items.length]);

  // Bring an item into view (e.g. after swiping through many in the viewer).
  useEffect(() => {
    if (focusId === null || !cell) return;
    const r = rowOf.get(focusId);
    if (r === undefined) return;
    const el = ref.current!;
    const offset = el.getBoundingClientRect().top + window.scrollY;
    const rowTop = offset + rows[r].top;
    const headerH = 120;
    if (rowTop < window.scrollY + headerH || rowTop + cell > window.scrollY + window.innerHeight) {
      window.scrollTo({ top: Math.max(0, rowTop - window.innerHeight / 3) });
    }
  }, [focusId]);

  return (
    <div ref={ref} class="grid" style={{ height: `${height}px` }}>
      {cell > 0 && visible.map((row) =>
        row.type === 'h' ? (
          <div key={row.key} class="grid-day" style={{ transform: `translateY(${row.top}px)`, height: `${HEADER_H}px` }}>
            {row.label}
          </div>
        ) : (
          <div key={row.key} class="grid-row" style={{ transform: `translateY(${row.top}px)`, height: `${cell}px`, gap: `${GAP}px` }}>
            {items.slice(row.start, row.end).map((a, j) => (
              <Cell
                key={a.id}
                asset={a}
                size={cell}
                selected={selected ? selected.has(a.id) : null}
                onOpen={(range) => (selected ? onSelect(row.start + j, range) : onOpen(row.start + j))}
                onLongPress={() => onSelect(row.start + j, false)}
              />
            ))}
          </div>
        ),
      )}
    </div>
  );
}

const LONG_PRESS_MS = 500;

function Cell({ asset: a, size, selected, onOpen, onLongPress }: {
  asset: Asset;
  size: number;
  /** Null when not selecting. */
  selected: boolean | null;
  onOpen: (range: boolean) => void;
  onLongPress: () => void;
}) {
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading');
  // A long press selects the item; the click that ends it must not toggle it again.
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const longPressed = useRef(false);
  const cancelPress = () => {
    if (press.current) clearTimeout(press.current.timer);
    press.current = null;
  };
  return (
    <button
      type="button"
      class={cx('cell', state === 'ok' && 'loaded', selected !== null && 'selecting', selected && 'selected')}
      style={{ width: `${size}px`, height: `${size}px` }}
      onClick={(e) => {
        if (longPressed.current) {
          longPressed.current = false;
          return;
        }
        onOpen(e.shiftKey);
      }}
      onPointerDown={(e) => {
        longPressed.current = false;
        if (e.button !== 0 || selected !== null) return;
        cancelPress();
        press.current = {
          x: e.clientX, y: e.clientY,
          timer: setTimeout(() => {
            press.current = null;
            longPressed.current = true;
            navigator.vibrate?.(10);
            onLongPress();
          }, LONG_PRESS_MS),
        };
      }}
      onPointerMove={(e) => {
        if (press.current && Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > 10) cancelPress();
      }}
      onPointerUp={cancelPress}
      onPointerCancel={cancelPress}
      onPointerLeave={cancelPress}
      onContextMenu={(e) => {
        // Touch browsers open a context menu on a long press; the press selects instead.
        if (press.current || longPressed.current) e.preventDefault();
      }}
      aria-label={a.name}
      aria-pressed={selected ?? undefined}
      data-id={a.id}
    >
      {state !== 'error' ? (
        <img
          src={thumbUrl(a)}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={() => setState('ok')}
          onError={() => setState('error')}
        />
      ) : (
        <div class="cell-broken">
          <Icon name="alert" size={20} />
          <span>{a.name}</span>
        </div>
      )}
      {a.kind === 'video' && (
        <span class="badge-video">
          <Icon name="play" size={10} />
          {formatDuration(a.duration)}
        </span>
      )}
      {a.kind === 'audio' && (
        <span class="badge-video" aria-label="Audio">
          <Icon name="music" size={11} />
          {formatDuration(a.duration)}
        </span>
      )}
      {a.kind === 'markdown' && (
        <span class="badge-video" aria-label="Document">
          <Icon name="doc" size={11} />
          MD
        </span>
      )}
      {a.favorite && (
        <span class="badge-fav" aria-label="Favorite">
          <Icon name="heart" size={14} />
        </span>
      )}
      <MiniRating value={a.rating} />
      {(a.hidden || a.libraryHidden) && (
        <span class="badge-hidden" aria-label="Hidden">
          <Icon name="eye-off" size={13} />
        </span>
      )}
      {a.caption && (
        <span class={cx('badge-cap', `cap-${a.caption}`, a.captionCandidate && 'cand')} title={`Caption: ${CAPTION_LABELS[a.caption] ?? a.caption}${a.captionCandidate ? ' (candidate available)' : ''}`} />
      )}
      {selected !== null && (
        <span class="cell-check" aria-hidden="true">
          {selected && <Icon name="check" size={14} />}
        </span>
      )}
    </button>
  );
}
