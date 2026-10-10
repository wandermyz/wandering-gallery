import { render } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { api, ApiError, fileUrl, thumbUrl, type Asset, type CaptionFilter, type DatasetResult, type Folder, type Library, type Query } from './api';
import { Grid, type Density } from './Grid';
import { Viewer } from './Viewer';
import { ConfirmDialog, Icon, IconButton, Sheet, Spinner, Stars, Toasts, type ConfirmOptions, type ToastMsg } from './ui';
import { CAPTION_EVENT, cx, formatBytes, formatDate } from './util';
import './styles.css';

// ---- URL state ------------------------------------------------------------------
// The gallery state lives in the URL so the back button, reloads and bookmarks work.

interface Route {
  view: 'gallery' | 'trash';
  library: string;
  folder: string;
  favorite: boolean;
  minRating: number;
  kind: '' | 'image' | 'video';
  caption: '' | CaptionFilter;
  order: 'desc' | 'asc';
  flat: boolean;
  asset: number | null;
}

const CAPTION_FILTERS: ['' | CaptionFilter, string][] = [
  ['', 'All'], ['any', 'Captioned'], ['none', 'Uncaptioned'], ['generated', 'Generated'], ['edited', 'Edited'],
  ['approved', 'Approved'], ['needs_regen', 'Needs regen'], ['candidate', 'Has candidate'],
];

function readRoute(): Route {
  const p = new URLSearchParams(location.search);
  return {
    view: location.pathname.startsWith('/trash') ? 'trash' : 'gallery',
    library: p.get('lib') ?? '',
    folder: p.get('folder') ?? '',
    favorite: p.get('fav') === '1',
    minRating: Math.min(5, Math.max(0, Number(p.get('rating')) || 0)),
    kind: p.get('kind') === 'image' || p.get('kind') === 'video' ? (p.get('kind') as 'image' | 'video') : '',
    caption: CAPTION_FILTERS.some(([k]) => k && k === p.get('cap')) ? (p.get('cap') as CaptionFilter) : '',
    order: p.get('order') === 'asc' ? 'asc' : 'desc',
    flat: p.get('flat') === '1',
    asset: Number(p.get('a')) || null,
  };
}

function routeUrl(r: Route): string {
  const p = new URLSearchParams();
  if (r.library) p.set('lib', r.library);
  if (r.folder) p.set('folder', r.folder);
  if (r.favorite) p.set('fav', '1');
  if (r.minRating) p.set('rating', String(r.minRating));
  if (r.kind) p.set('kind', r.kind);
  if (r.caption) p.set('cap', r.caption);
  if (r.order === 'asc') p.set('order', 'asc');
  if (r.flat) p.set('flat', '1');
  if (r.asset) p.set('a', String(r.asset));
  const s = p.toString();
  return (r.view === 'trash' ? '/trash' : '/') + (s ? `?${s}` : '');
}

function useRoute() {
  const [route, setRoute] = useState(readRoute);
  useEffect(() => {
    const on = () => setRoute(readRoute());
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  const nav = useCallback((patch: Partial<Route>, mode: 'push' | 'replace' = 'push') => {
    setRoute((cur) => {
      const next = { ...cur, ...patch };
      const url = routeUrl(next);
      if (url !== location.pathname + location.search) {
        history[mode === 'push' ? 'pushState' : 'replaceState']({ viewer: !!next.asset }, '', url);
      }
      return next;
    });
  }, []);
  return [route, nav] as const;
}

// ---- Asset list with pagination ---------------------------------------------------------

function queryOf(r: Route): Query {
  return {
    library: r.library || undefined,
    folder: r.library ? r.folder : undefined,
    recursive: !r.library || !r.folder ? !r.flat || !r.library : !r.flat,
    favorite: r.favorite,
    minRating: r.minRating,
    kind: r.kind || undefined,
    caption: r.caption || undefined,
    order: r.order,
  };
}

function useAssets(q: Query, enabled: boolean) {
  const key = JSON.stringify(q);
  const [items, setItems] = useState<Asset[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gen = useRef(0);
  const loadingMore = useRef(false);

  const reload = useCallback(async (soft = false) => {
    const g = ++gen.current;
    if (!soft) {
      setLoading(true);
      setItems([]);
      setNext(null);
      setTotal(null);
    }
    setError(null);
    try {
      // On a soft refresh keep at least as many items as are loaded, so scroll position is stable.
      const page = await api.assets(q, null, 120);
      if (g !== gen.current) return;
      setItems(page.items);
      setNext(page.next);
      setTotal(page.total ?? null);
    } catch (e) {
      if (g === gen.current) setError((e as Error).message);
    } finally {
      if (g === gen.current) setLoading(false);
    }
  }, [key]);

  useEffect(() => {
    if (enabled) void reload();
  }, [key, enabled]);

  const loadMore = useCallback(async () => {
    if (!next || loadingMore.current) return;
    loadingMore.current = true;
    const g = gen.current;
    try {
      const page = await api.assets(q, next, 240);
      if (g !== gen.current) return;
      setItems((cur) => {
        const seen = new Set(cur.map((a) => a.id));
        return [...cur, ...page.items.filter((a) => !seen.has(a.id))];
      });
      setNext(page.next);
    } catch (e) {
      if (g === gen.current) setError((e as Error).message);
    } finally {
      loadingMore.current = false;
    }
  }, [next, key]);

  /** Merges newly arrived assets at the top without disturbing what is loaded. */
  const refreshHead = useCallback(async (removed: number[]) => {
    const g = gen.current;
    try {
      const page = await api.assets(q, null, 120);
      if (g !== gen.current) return;
      setTotal(page.total ?? null);
      setItems((cur) => {
        const gone = new Set(removed);
        const fresh = new Map(page.items.map((a) => [a.id, a]));
        // A removed id that still matches (moved within the view) stays.
        const kept = cur.filter((a) => !gone.has(a.id) || fresh.has(a.id)).map((a) => fresh.get(a.id) ?? a);
        if (!kept.length) return page.items;
        const keptIds = new Set(kept.map((a) => a.id));
        // New items newer than the current head go first (or last for ascending order).
        const head = kept[0];
        const newer = page.items.filter((a) => !keptIds.has(a.id) &&
          (q.order === 'asc' ? false : a.mtimeMs > head.mtimeMs || (a.mtimeMs === head.mtimeMs && a.id > head.id)));
        // Items that newly match inside the loaded window (e.g. restored from trash).
        const lastLoaded = kept[kept.length - 1];
        const inside = page.items.filter((a) => !keptIds.has(a.id) && !newer.includes(a) &&
          (q.order === 'asc' ? a.mtimeMs <= lastLoaded.mtimeMs : a.mtimeMs >= lastLoaded.mtimeMs));
        const merged = [...newer, ...kept, ...inside];
        if (inside.length) {
          merged.sort((a, b) => (q.order === 'asc' ? a.mtimeMs - b.mtimeMs || a.id - b.id : b.mtimeMs - a.mtimeMs || b.id - a.id));
        }
        return merged;
      });
    } catch {
      /* transient; next event will retry */
    }
  }, [key]);

  const patch = useCallback((a: Asset) => setItems((cur) => cur.map((x) => (x.id === a.id ? { ...x, ...a } : x))), []);
  const remove = useCallback((id: number) => {
    setItems((cur) => cur.filter((x) => x.id !== id));
    setTotal((t) => (t === null ? t : Math.max(0, t - 1)));
  }, []);

  return { items, hasMore: !!next, total, loading, error, reload, loadMore, refreshHead, patch, remove };
}

// ---- App ---------------------------------------------------------------------------

let toastSeq = 0;

function App() {
  const [route, nav] = useRoute();
  const [libraries, setLibraries] = useState<Library[] | null>(null);
  const [libError, setLibError] = useState<string | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [menu, setMenu] = useState(false);
  const [filters, setFilters] = useState(false);
  const [density, setDensity] = useState<Density>(() => (localStorage.getItem('wg.density') as Density) || 'm');
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const [confirm, setConfirm] = useState<{ opts: ConfirmOptions; resolve: (ok: boolean) => void } | null>(null);
  const [status, setStatus] = useState<{ pending: number; scanning: boolean; trash: number; trashRetentionDays: number } | null>(null);
  const [focusId, setFocusId] = useState<number | null>(null);
  const [newCount, setNewCount] = useState(0);

  const q = useMemo(() => queryOf(route), [route.library, route.folder, route.favorite, route.minRating, route.kind, route.caption, route.order, route.flat]);
  const list = useAssets(q, route.view === 'gallery');

  const toast = useCallback((text: string, opts: Partial<ToastMsg> = {}) => {
    const id = ++toastSeq;
    setToasts((t) => [...t.slice(-2), { id, text, ...opts }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), opts.action ? 6000 : 3500);
  }, []);
  const ask = (opts: ConfirmOptions) => new Promise<boolean>((resolve) => setConfirm({ opts, resolve }));

  const loadLibraries = useCallback(() =>
    api.libraries().then((r) => {
      setLibraries(r.libraries);
      setLibError(null);
    }, (e) => setLibError((e as Error).message)), []);
  const loadStatus = useCallback(() => api.status().then(setStatus, () => {}), []);

  useEffect(() => {
    void loadLibraries();
    void loadStatus();
  }, []);

  useEffect(() => {
    localStorage.setItem('wg.density', density);
  }, [density]);

  // Folder list for the current library/folder.
  useEffect(() => {
    if (!route.library || route.view !== 'gallery') {
      setFolders([]);
      return;
    }
    let alive = true;
    api.folders(route.library, route.folder).then((r) => alive && setFolders(r.folders), () => alive && setFolders([]));
    return () => {
      alive = false;
    };
  }, [route.library, route.folder, route.view, libraries]);

  // Live updates from the server (new / removed files).
  const listRef = useRef(list);
  listRef.current = list;
  useEffect(() => {
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      es = new EventSource('/api/events');
      es.addEventListener('change', (ev) => {
        const data = JSON.parse((ev as MessageEvent).data) as { libraries: string[]; removed: number[]; captions?: number[] };
        if (data.captions?.length) window.dispatchEvent(new CustomEvent(CAPTION_EVENT, { detail: data.captions }));
        const cur = readRoute();
        if (!cur.library || data.libraries.includes(cur.library)) {
          if (window.scrollY > 400 && !cur.asset) setNewCount((n) => n + 1);
          void listRef.current.refreshHead(data.removed);
        }
        void loadLibraries();
        void loadStatus();
      });
      es.onerror = () => {
        es?.close();
        timer = setTimeout(connect, 5000);
      };
    };
    connect();
    // Reconnect and refresh after the phone wakes / tab is shown again.
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void listRef.current.refreshHead([]);
        void loadStatus();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      es?.close();
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // Poll indexing progress while there is pending work.
  useEffect(() => {
    if (!status || (!status.pending && !status.scanning)) return;
    const t = setTimeout(() => {
      void loadStatus();
      void list.refreshHead([]);
    }, 2500);
    return () => clearTimeout(t);
  }, [status]);

  // Lock page scroll while the viewer is open.
  useEffect(() => {
    document.documentElement.classList.toggle('viewer-open', !!route.asset);
  }, [route.asset]);

  const libById = useMemo(() => new Map((libraries ?? []).map((l) => [l.id, l])), [libraries]);
  const currentLib = route.library ? libById.get(route.library) : undefined;

  // ---- Actions -----------------------------------------------------------------------

  const applyAsset = (a: Asset) => {
    list.patch(a);
    // Drop it from filtered views it no longer matches.
    if ((route.favorite && !a.favorite) || a.rating < route.minRating) {
      // Keep it while it is open in the viewer, so the viewer does not jump.
      if (!route.asset) list.remove(a.id);
    }
  };

  const onFavorite = async (a: Asset) => {
    const optimistic = { ...a, favorite: !a.favorite };
    list.patch(optimistic);
    try {
      applyAsset(await api.favorite(a.id, optimistic.favorite));
    } catch (e) {
      list.patch(a);
      toast(`Could not update favorite: ${(e as Error).message}`, { kind: 'error' });
    }
  };

  const onRate = async (a: Asset, rating: number) => {
    list.patch({ ...a, rating });
    try {
      applyAsset(await api.rate(a.id, rating));
    } catch (e) {
      list.patch(a);
      toast(`Could not update rating: ${(e as Error).message}`, { kind: 'error' });
    }
  };

  const onDelete = async (a: Asset) => {
    const lib = libById.get(a.library);
    if (!lib?.writable) {
      toast('This library is read-only.', { kind: 'error' });
      return;
    }
    const ok = await ask({
      title: 'Move to trash?',
      message: (
        <>
          <p class="break"><strong>{a.name}</strong></p>
          <p class="muted">The file is moved out of the library folder into the trash. You can restore it from Trash for {status?.trashRetentionDays ?? 7} days.</p>
        </>
      ),
      confirm: 'Move to trash',
      danger: true,
    });
    if (!ok) return;
    const idx = list.items.findIndex((x) => x.id === a.id);
    try {
      await api.trash(a);
    } catch (e) {
      toast((e as Error).message, { kind: 'error' });
      if (e instanceof ApiError && e.status === 404) list.remove(a.id);
      return;
    }
    // Move the viewer to a neighbour before removing.
    if (route.asset === a.id) {
      const neighbour = list.items[idx + 1] ?? list.items[idx - 1];
      if (neighbour) nav({ asset: neighbour.id }, 'replace');
      else closeViewer();
    }
    list.remove(a.id);
    void loadStatus();
    void loadLibraries();
    toast('Moved to trash', {
      action: {
        label: 'Undo',
        run: async () => {
          try {
            await api.restore(a.id);
            void list.refreshHead([]);
            void loadStatus();
            toast('Restored');
          } catch (err) {
            toast((err as Error).message, { kind: 'error' });
          }
        },
      },
    });
  };

  const onDataset = (a: Asset, r: DatasetResult) => {
    const where = `${r.dataset}${r.created ? ' (new)' : ''}`;
    const renamed = (r.name !== a.name ? ` as ${r.name}` : '') + (r.replaced ? ' (replaced the old one)' : '');
    void loadLibraries();
    if (r.mode === 'copy') {
      toast(`Copied to ${where}${renamed}`);
      return;
    }
    const moved = r.asset;
    const inView = !!moved && (route.library
      ? moved.library === route.library && (!route.folder || moved.folder === route.folder ||
        (!route.flat && moved.folder.startsWith(route.folder + '/')))
      : !!libById.get(moved.library)?.showInAll);
    if (moved && inView) {
      list.patch(moved);
    } else {
      // Gone from this view: step the viewer to a neighbour first, as for a delete.
      const idx = list.items.findIndex((x) => x.id === a.id);
      if (route.asset === a.id) {
        const neighbour = idx < 0 ? null : list.items[idx + 1] ?? list.items[idx - 1];
        if (neighbour) nav({ asset: neighbour.id }, 'replace');
        else closeViewer();
      }
      list.remove(a.id);
    }
    toast(`Moved to ${where}${renamed}`);
  };

  // The fetched original is kept so a second tap can share instantly: iOS only allows
  // navigator.share() shortly after a tap, and a large download can outlast that window.
  const shareCache = useRef<{ id: number; v: string; file: File } | null>(null);
  const onShare = async (a: Asset) => {
    const download = () => {
      const link = document.createElement('a');
      link.href = `${fileUrl(a)}&download=1`;
      link.download = a.name;
      link.click();
    };
    if (!navigator.canShare) return download();
    let file = shareCache.current?.id === a.id && shareCache.current.v === a.v ? shareCache.current.file : null;
    if (!file) {
      try {
        const r = await fetch(fileUrl(a));
        if (!r.ok) throw new Error(`${r.status}`);
        file = new File([await r.blob()], a.name, { type: a.mime });
        shareCache.current = { id: a.id, v: a.v, file };
      } catch (e) {
        toast(`Could not load file: ${(e as Error).message}`, { kind: 'error' });
        return;
      }
    }
    if (!navigator.canShare({ files: [file] })) return download();
    try {
      await navigator.share({ files: [file] });
    } catch (e) {
      const name = (e as DOMException).name;
      if (name === 'NotAllowedError') toast('File ready. Tap Share again.');
      else if (name !== 'AbortError') toast(`Share failed: ${(e as Error).message}`, { kind: 'error' });
    }
  };

  const openViewer = (index: number) => {
    const a = list.items[index];
    if (a) nav({ asset: a.id });
  };

  const closeViewer = () => {
    const id = route.asset;
    setFocusId(id);
    // If we pushed the viewer entry, go back so the browser history stays clean.
    if (history.state?.viewer) history.back();
    else nav({ asset: null }, 'replace');
  };

  const rescan = async () => {
    try {
      await api.rescan(route.library || undefined);
      toast('Rescanning…');
      setTimeout(() => void loadStatus(), 800);
    } catch (e) {
      toast((e as Error).message, { kind: 'error' });
    }
  };

  // ---- Render -------------------------------------------------------------------------

  const filtersActive = route.favorite || route.minRating > 0 || !!route.kind || !!route.caption || route.order === 'asc' || route.flat;
  const title = route.view === 'trash'
    ? 'Trash'
    : route.favorite && !route.library ? 'Favorites' : currentLib?.name ?? 'All media';
  const crumbs = route.folder ? route.folder.split('/') : [];

  return (
    <div class="app">
      <header class="topbar">
        <IconButton icon="menu" label="Libraries" onClick={() => setMenu(true)} />
        <div class="topbar-title">
          <h1 onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}>{title}</h1>
          {route.view === 'gallery' && (
            <span class="topbar-sub">
              {list.total !== null ? `${list.total.toLocaleString()} item${list.total === 1 ? '' : 's'}` : ''}
              {status?.pending ? ` · indexing ${status.pending}` : status?.scanning ? ' · scanning' : ''}
            </span>
          )}
        </div>
        {route.view === 'gallery' && (
          <>
            <IconButton
              icon="heart"
              label={route.favorite ? 'Show all' : 'Show favorites'}
              active={route.favorite}
              filled={route.favorite}
              onClick={() => nav({ favorite: !route.favorite })}
            />
            <IconButton icon="filter" label="Filter and view options" active={filtersActive} onClick={() => setFilters(true)} />
          </>
        )}
      </header>

      {route.view === 'gallery' && route.library && (crumbs.length > 0 || folders.length > 0) && (
        <nav class="folders" aria-label="Folders">
          {crumbs.length > 0 && (
            <div class="crumbs">
              <button type="button" class="crumb" onClick={() => nav({ folder: '' })}>{currentLib?.name ?? route.library}</button>
              {crumbs.map((c, i) => (
                <span key={i} class="crumb-wrap">
                  <Icon name="next" size={12} />
                  <button
                    type="button"
                    class={cx('crumb', i === crumbs.length - 1 && 'current')}
                    onClick={() => nav({ folder: crumbs.slice(0, i + 1).join('/') })}
                  >
                    {c}
                  </button>
                </span>
              ))}
            </div>
          )}
          {folders.length > 0 && (
            <div class="folder-strip">
              {folders.map((f) => (
                <button type="button" key={f.path} class="folder-chip" onClick={() => nav({ folder: f.path })}>
                  {f.cover ? <img src={thumbUrl(f.cover)} alt="" loading="lazy" /> : <span class="folder-ph"><Icon name="folder" size={20} /></span>}
                  <span class="folder-name">{f.name}</span>
                  <span class="folder-count">{f.count}</span>
                </button>
              ))}
            </div>
          )}
        </nav>
      )}

      <main class="content">
        {route.view === 'trash' ? (
          <TrashView toast={toast} ask={ask} onChange={() => {
            void loadStatus();
            void loadLibraries();
          }} />
        ) : (
          <>
            {currentLib && !currentLib.available && (
              <div class="banner banner-error">
                <Icon name="alert" size={18} /> {currentLib.error ?? 'This library is unavailable.'}
              </div>
            )}
            {libError && <div class="banner banner-error"><Icon name="alert" size={18} /> {libError}</div>}
            {list.error && (
              <div class="banner banner-error">
                <Icon name="alert" size={18} /> {list.error}
                <button type="button" class="btn btn-sm" onClick={() => void list.reload()}>Retry</button>
              </div>
            )}
            {list.loading && !list.items.length ? (
              <div class="skeleton-grid" aria-busy="true">
                {Array.from({ length: 24 }, (_, i) => <div key={i} class="skeleton" />)}
              </div>
            ) : list.items.length === 0 && !list.error ? (
              <EmptyState route={route} scanning={!!status?.scanning || !!status?.pending} onClear={() => nav({ favorite: false, minRating: 0, kind: '', caption: '' })} />
            ) : (
              <Grid
                items={list.items}
                density={density}
                groupByDay={route.order === 'desc' && density !== 's'}
                hasMore={list.hasMore}
                onNeedMore={() => void list.loadMore()}
                onOpen={openViewer}
                focusId={focusId}
              />
            )}
            {list.hasMore && list.items.length > 0 && <div class="load-more"><Spinner /></div>}
          </>
        )}
      </main>

      {newCount > 0 && !route.asset && (
        <button
          type="button"
          class="new-pill"
          onClick={() => {
            setNewCount(0);
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
        >
          New items ↑
        </button>
      )}

      <Sheet open={menu} onClose={() => setMenu(false)} title="Libraries" class="sheet-left">
        <nav class="lib-list">
          <button type="button" class={cx('lib-item', route.view === 'gallery' && !route.library && !route.favorite && 'active')}
            onClick={() => { setMenu(false); nav({ view: 'gallery', library: '', folder: '', favorite: false, asset: null }); }}>
            <Icon name="grid" />
            <span class="lib-name">All media</span>
            <span class="lib-count">{libraries?.reduce((n, l) => n + (l.showInAll ? l.count : 0), 0).toLocaleString() ?? ''}</span>
          </button>
          <button type="button" class={cx('lib-item', route.view === 'gallery' && !route.library && route.favorite && 'active')}
            onClick={() => { setMenu(false); nav({ view: 'gallery', library: '', folder: '', favorite: true, asset: null }); }}>
            <Icon name="heart" />
            <span class="lib-name">Favorites</span>
          </button>
          <div class="lib-sep">Libraries</div>
          {libraries === null && <Spinner />}
          {libraries?.map((l) => (
            <button type="button" key={l.id} class={cx('lib-item', route.view === 'gallery' && route.library === l.id && 'active')}
              onClick={() => { setMenu(false); nav({ view: 'gallery', library: l.id, folder: '', favorite: false, asset: null }); }}>
              <Icon name="folder" />
              <span class="lib-name">
                {l.name}
                {!l.writable && <span class="lib-ro" title="Read-only"><Icon name="lock" size={12} /></span>}
                {!l.available && <span class="lib-err">unavailable</span>}
              </span>
              <span class="lib-count">{l.scanning ? '…' : l.count.toLocaleString()}</span>
            </button>
          ))}
          <div class="lib-sep" />
          <button type="button" class={cx('lib-item', route.view === 'trash' && 'active')}
            onClick={() => { setMenu(false); nav({ view: 'trash', asset: null }); }}>
            <Icon name="trash" />
            <span class="lib-name">Trash</span>
            <span class="lib-count">{status?.trash || ''}</span>
          </button>
          <button type="button" class="lib-item" onClick={() => { setMenu(false); void rescan(); }}>
            <Icon name="refresh" />
            <span class="lib-name">Rescan {currentLib ? currentLib.name : 'all libraries'}</span>
          </button>
        </nav>
      </Sheet>

      <Sheet open={filters} onClose={() => setFilters(false)} title="View">
        <div class="filter-group">
          <div class="filter-label">Show</div>
          <div class="seg">
            {(['', 'image', 'video'] as const).map((k) => (
              <button type="button" key={k || 'all'} class={cx(route.kind === k && 'on')} onClick={() => nav({ kind: k }, 'replace')}>
                {k === '' ? 'All' : k === 'image' ? 'Images' : 'Videos'}
              </button>
            ))}
          </div>
        </div>
        <div class="filter-group">
          <div class="filter-label">Favorites</div>
          <div class="seg">
            <button type="button" class={cx(!route.favorite && 'on')} onClick={() => nav({ favorite: false }, 'replace')}>All</button>
            <button type="button" class={cx(route.favorite && 'on')} onClick={() => nav({ favorite: true }, 'replace')}>Favorites only</button>
          </div>
        </div>
        <div class="filter-group">
          <div class="filter-label">Minimum rating {route.minRating ? `(${route.minRating}+)` : '(any)'}</div>
          <Stars value={route.minRating} onChange={(v) => nav({ minRating: v }, 'replace')} size={30} />
        </div>
        <div class="filter-group">
          <div class="filter-label">Caption</div>
          <div class="seg seg-wrap">
            {CAPTION_FILTERS.map(([k, label]) => (
              <button type="button" key={k || 'all'} class={cx(route.caption === k && 'on')} onClick={() => nav({ caption: k }, 'replace')}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <div class="filter-group">
          <div class="filter-label">Sort by date</div>
          <div class="seg">
            <button type="button" class={cx(route.order === 'desc' && 'on')} onClick={() => nav({ order: 'desc' }, 'replace')}>Newest first</button>
            <button type="button" class={cx(route.order === 'asc' && 'on')} onClick={() => nav({ order: 'asc' }, 'replace')}>Oldest first</button>
          </div>
        </div>
        {route.library && (
          <div class="filter-group">
            <div class="filter-label">Subfolders</div>
            <div class="seg">
              <button type="button" class={cx(!route.flat && 'on')} onClick={() => nav({ flat: false }, 'replace')}>Include</button>
              <button type="button" class={cx(route.flat && 'on')} onClick={() => nav({ flat: true }, 'replace')}>This folder only</button>
            </div>
          </div>
        )}
        <div class="filter-group">
          <div class="filter-label">Thumbnail size</div>
          <div class="seg">
            {(['s', 'm', 'l'] as const).map((d) => (
              <button type="button" key={d} class={cx(density === d && 'on')} onClick={() => setDensity(d)}>
                {d === 's' ? 'Small' : d === 'm' ? 'Medium' : 'Large'}
              </button>
            ))}
          </div>
        </div>
        {filtersActive && (
          <button type="button" class="btn btn-block" onClick={() => nav({ favorite: false, minRating: 0, kind: '', caption: '', order: 'desc', flat: false }, 'replace')}>
            Reset filters
          </button>
        )}
      </Sheet>

      {route.asset !== null && route.view === 'gallery' && (
        list.loading && !list.items.length ? (
          <div class="viewer"><Spinner /></div>
        ) : (
          <ViewerHost
            items={list.items}
            id={route.asset}
            hasMore={list.hasMore}
            onNeedMore={() => void list.loadMore()}
            onNavigate={(id) => nav({ asset: id }, 'replace')}
            onClose={closeViewer}
            onFavorite={onFavorite}
            onRate={onRate}
            onDelete={onDelete}
            onShare={onShare}
            onDataset={onDataset}
            writable={(a) => !!libById.get(a.library)?.writable}
            libName={(id) => libById.get(id)?.name ?? id}
          />
        )
      )}

      <ConfirmDialog opts={confirm?.opts ?? null} onResult={(ok) => { confirm?.resolve(ok); setConfirm(null); }} />
      <Toasts toasts={toasts} dismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
    </div>
  );
}

/** Supplies the viewer with the asset list, fetching a deep-linked asset that is not loaded yet. */
function ViewerHost(props: Parameters<typeof Viewer>[0] & { libName: (id: string) => string }) {
  const { items, id, libName, ...rest } = props;
  const [extra, setExtra] = useState<Asset | null>(null);
  const inList = items.some((a) => a.id === id);
  useEffect(() => {
    if (inList) {
      setExtra(null);
      return;
    }
    let alive = true;
    api.asset(id).then((a) => alive && setExtra(a), () => alive && setExtra(null));
    return () => {
      alive = false;
    };
  }, [id, inList]);
  const list = inList ? items : extra && extra.id === id ? [extra] : items;
  const withLib = useMemo(() => list.map((a) => (a.libraryName ? a : { ...a, libraryName: libName(a.library) })), [list]);
  const onFavorite = async (a: Asset) => {
    await rest.onFavorite(a);
    if (!inList && extra) setExtra(await api.asset(extra.id));
  };
  const onRate = async (a: Asset, r: number) => {
    await rest.onRate(a, r);
    if (!inList && extra) setExtra(await api.asset(extra.id));
  };
  return <Viewer {...rest} items={withLib} id={id} onFavorite={onFavorite} onRate={onRate} />;
}

function EmptyState({ route, scanning, onClear }: { route: Route; scanning: boolean; onClear: () => void }) {
  const filtered = route.favorite || route.minRating > 0 || !!route.kind || !!route.caption;
  return (
    <div class="empty">
      <Icon name={route.favorite ? 'heart' : 'grid'} size={40} />
      {filtered ? (
        <>
          <p>Nothing matches these filters.</p>
          <button type="button" class="btn" onClick={onClear}>Clear filters</button>
        </>
      ) : scanning ? (
        <p>Scanning library…</p>
      ) : (
        <p>No images or videos here yet.</p>
      )}
    </div>
  );
}

function TrashView({ toast, ask, onChange }: {
  toast: (t: string, o?: Partial<ToastMsg>) => void;
  ask: (o: ConfirmOptions) => Promise<boolean>;
  onChange: () => void;
}) {
  const [data, setData] = useState<{ retentionDays: number; items: Asset[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const load = () => api.trashList().then(setData, (e) => setError((e as Error).message));
  useEffect(() => {
    void load();
  }, []);

  const restore = async (a: Asset) => {
    setBusy(a.id);
    try {
      const r = await api.restore(a.id);
      toast(r.path !== a.path ? `Restored as ${r.name}` : 'Restored');
      await load();
      onChange();
    } catch (e) {
      toast((e as Error).message, { kind: 'error' });
    } finally {
      setBusy(null);
    }
  };
  const purge = async (a: Asset) => {
    const ok = await ask({
      title: 'Delete permanently?',
      message: <><p class="break"><strong>{a.name}</strong></p><p class="muted">This cannot be undone.</p></>,
      confirm: 'Delete forever',
      danger: true,
    });
    if (!ok) return;
    setBusy(a.id);
    try {
      await api.purge(a.id);
      toast('Deleted permanently');
      await load();
      onChange();
    } catch (e) {
      toast((e as Error).message, { kind: 'error' });
    } finally {
      setBusy(null);
    }
  };

  if (error) return <div class="banner banner-error"><Icon name="alert" size={18} /> {error}</div>;
  if (!data) return <Spinner label="Loading trash" />;
  return (
    <div class="trash">
      <p class="trash-note">
        Items are kept for {data.retentionDays} day{data.retentionDays === 1 ? '' : 's'}, then deleted permanently.
        Restoring puts the file back where it was, with its favorite and rating.
      </p>
      {data.items.length === 0 ? (
        <div class="empty"><Icon name="trash" size={40} /><p>Trash is empty.</p></div>
      ) : (
        <ul class="trash-list">
          {data.items.map((a) => {
            const days = Math.max(0, Math.ceil(((a.expiresAtMs ?? 0) - Date.now()) / 86_400_000));
            return (
              <li key={a.id} class="trash-item">
                <img src={thumbUrl(a)} alt="" loading="lazy" />
                <div class="trash-info">
                  <div class="trash-name break">{a.name}</div>
                  <div class="muted small">
                    {a.libraryName} · {a.folder || 'root'} · {formatBytes(a.size)}
                  </div>
                  <div class="muted small">
                    Deleted {a.trashedAtMs ? formatDate(a.trashedAtMs) : ''} · {days ? `${days} day${days === 1 ? '' : 's'} left` : 'expires soon'}
                    {a.favorite ? ' · ♥' : ''}{a.rating ? ` · ${a.rating}★` : ''}
                  </div>
                </div>
                <div class="trash-actions">
                  <button type="button" class="btn btn-sm" disabled={busy === a.id} onClick={() => restore(a)}>
                    <Icon name="restore" size={16} /> Restore
                  </button>
                  <button type="button" class="btn btn-sm btn-danger-ghost" disabled={busy === a.id} onClick={() => purge(a)}>
                    Delete
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

render(<App />, document.getElementById('app')!);
