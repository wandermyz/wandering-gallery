import { useCallback, useRef, useState } from 'preact/hooks';
import { ApiError } from '../gallery/api';
import { Icon, Sheet, Toasts, type ToastMsg } from '../common/ui';
import { cx } from '../common/util';
import { genApi, type FlowInfo, type Run, type TagHit } from './api';
import { RunCard, Stepper, useKept, useRunUpdates } from './TagsFlowPage';

const MAX_BATCH = 16;
/** Candidates offered per typed tag, besides the tag as typed. */
const CANDIDATES = 5;

const split = (tags: string) => tags.split(',').map((t) => t.trim()).filter(Boolean);
/** Compares a typed tag with a Danbooru tag in either form: `Red_Eyes`, `red eyes`, `a \(b\)`. */
const key = (tag: string) => tag.toLowerCase().replace(/\\/g, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

/** One typed tag in the picker: what was typed and what the search found. */
interface Pick {
  typed: string;
  hits: TagHit[];
  /** The tag as typed is a Danbooru tag. */
  exact: boolean;
  /** The chosen replacement; `typed` keeps the tag as typed. */
  choice: string;
}

/**
 * Tags typed by hand → images. Before a run, every typed tag that has not been
 * checked yet is looked up in the Danbooru tag set; a picker offers the tag as typed
 * and the closest matches. The default (quality and LoRA) tags are never searched.
 */
export function TypedTagsFlowPage({ flow, onComfyDown }: { flow: FlowInfo; onComfyDown: () => void }) {
  const k = (name: string) => `${flow.id}:${name}`;
  const [tags, setTags] = useKept(k('tags'), flow.defaultTags);
  const [batch, setBatch] = useKept(k('batch'), 4);
  /** Tags already checked or picked (by key): not searched again. */
  const [checked, setChecked] = useKept<Set<string>>(k('checked'), new Set());
  const [runs, setRuns] = useKept<Run[]>(k('runs'), []);
  const [searching, setSearching] = useState(false);
  const [starting, setStarting] = useState(false);
  /** The open picker, and whether applying it starts a run. */
  const [picker, setPicker] = useState<{ picks: Pick[]; thenRun: boolean } | null>(null);
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const toastId = useRef(0);

  const toast = useCallback((text: string, kind: 'error' | 'info' = 'info') => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 3500);
  }, []);
  const onError = useCallback((msg: string, e?: unknown) => {
    if (e instanceof ApiError && e.status === 503) onComfyDown();
    toast(msg, 'error');
  }, [toast, onComfyDown]);

  useRunUpdates(flow.id, runs, setRuns);

  const defaults = new Set(split(flow.defaultTags).map(key));
  const typed = split(tags);
  const unchecked = typed.filter((t, i) => !defaults.has(key(t)) && !checked.has(key(t)) && typed.findIndex((x) => key(x) === key(t)) === i);

  const start = async (text: string) => {
    setStarting(true);
    try {
      const run = await genApi.start(flow.id, '', [text], batch);
      setRuns((rs) => [run, ...rs]);
      toast(`Queued ${run.jobs.length} image${run.jobs.length > 1 ? 's' : ''}`);
    } catch (e) {
      onError((e as Error).message, e);
    } finally {
      setStarting(false);
    }
  };

  /** Searches the unchecked tags and opens the picker; with nothing to check, goes straight on. */
  const check = async (thenRun: boolean) => {
    if (!unchecked.length) {
      if (thenRun) await start(typed.join(', '));
      return;
    }
    setSearching(true);
    try {
      const { results } = await genApi.searchTags(unchecked, CANDIDATES + 1);
      setPicker({
        thenRun,
        picks: unchecked.map((t) => {
          // The tag as typed comes first; a hit that is the same tag is not offered twice.
          const all = results[t] ?? [];
          const hits = all.filter((h) => key(h.prompt) !== key(t)).slice(0, CANDIDATES);
          return { typed: t, hits, exact: all.some((h) => key(h.prompt) === key(t)), choice: t };
        }),
      });
    } catch (e) {
      onError(`Tag search: ${(e as Error).message}`, e);
    } finally {
      setSearching(false);
    }
  };

  const apply = (picks: Pick[], thenRun: boolean) => {
    const by = new Map(picks.map((p) => [key(p.typed), p.choice]));
    const seen = new Set<string>();
    // Replace in place and drop duplicates a pick may have created.
    const next = typed.map((t) => by.get(key(t)) ?? t).filter((t) => !seen.has(key(t)) && seen.add(key(t)));
    const text = next.join(', ');
    setTags(text);
    setChecked((c) => new Set([...c, ...picks.flatMap((p) => [key(p.typed), key(p.choice)])]));
    setPicker(null);
    if (thenRun) void start(text);
  };

  const cancel = async (run: Run) => {
    try {
      const r = await genApi.cancel(run.id);
      setRuns((rs) => rs.map((x) => (x.id === r.id ? r : x)));
    } catch (e) {
      onError((e as Error).message, e);
    }
  };

  const reuse = (run: Run) => {
    const text = run.variations[0] ?? '';
    setTags(text);
    // They were used for a run, so they are taken as checked.
    setChecked((c) => new Set([...c, ...split(text).map(key)]));
    setBatch(run.batch);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const busy = searching || starting;
  const canRun = flow.ready && typed.some((t) => !defaults.has(key(t))) && !busy;

  return (
    <div class="gen">
      <section class="gen-card">
        <label class="gen-label" for="typed-tags">Tags <span class="muted">comma separated, quality tags included</span></label>
        <textarea id="typed-tags" class="cap-text gen-tags" rows={4} value={tags} placeholder="1girl, red eyes, cat ears, …"
          onInput={(e) => setTags(e.currentTarget.value)} />
        <div class="gen-row">
          <span class="muted small" aria-live="polite">
            {unchecked.length ? `${unchecked.length} tag${unchecked.length > 1 ? 's' : ''} not checked yet` : 'All tags checked'}
          </span>
          <button type="button" class="btn" disabled={!unchecked.length || busy} onClick={() => void check(false)}>
            {searching && !picker ? <span class="spinner spinner-sm" /> : <Icon name="search" size={18} />}
            Check tags
          </button>
        </div>
      </section>

      <section class="gen-card gen-row gen-go">
        <Stepper label="Images" value={batch} min={1} max={MAX_BATCH} onChange={setBatch} />
        <button type="button" class="btn btn-primary" disabled={!canRun} onClick={() => void check(true)}
          title={unchecked.length ? 'Checks the new tags first' : undefined}>
          {busy ? <span class="spinner spinner-sm" /> : <Icon name="play" size={16} />}
          {unchecked.length ? 'Check and generate' : `Generate ${batch} image${batch > 1 ? 's' : ''}`}
        </button>
      </section>

      {runs.length > 0 && (
        <div class="gen-h2-row">
          <h2 class="gen-h2">Runs</h2>
          <button type="button" class="btn btn-sm" disabled={runs.every((r) => r.status === 'running')}
            onClick={() => setRuns((rs) => rs.filter((r) => r.status === 'running'))}>
            <Icon name="trash" size={16} />Clear
          </button>
        </div>
      )}
      {runs.map((run) => <RunCard key={run.id} run={run} onCancel={() => void cancel(run)} onReuse={() => reuse(run)} />)}

      {picker && (
        <TagPicker picks={picker.picks} thenRun={picker.thenRun} batch={batch}
          onApply={(picks) => apply(picks, picker.thenRun)} onClose={() => setPicker(null)} />
      )}
      <Toasts toasts={toasts} dismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
    </div>
  );
}

const posts = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

/** One choice per typed tag: as typed (the default) or one of the closest Danbooru tags. */
function TagPicker({ picks: initial, thenRun, batch, onApply, onClose }: {
  picks: Pick[]; thenRun: boolean; batch: number; onApply: (picks: Pick[]) => void; onClose: () => void;
}) {
  const [picks, setPicks] = useState(initial);
  const choose = (i: number, choice: string) => setPicks((ps) => ps.map((p, j) => (j === i ? { ...p, choice } : p)));
  const changed = picks.filter((p) => p.choice !== p.typed).length;
  return (
    <Sheet open onClose={onClose} title="Pick tags" class="tag-picker">
      <ol class="tp-list">
        {picks.map((p, i) => (
          <li key={p.typed} class="tp-tag">
            <fieldset>
              <legend class="gen-label">{p.typed}</legend>
              <label class={cx('tp-opt', p.choice === p.typed && 'on')}>
                <input type="radio" name={`tp-${i}`} checked={p.choice === p.typed} onChange={() => choose(i, p.typed)} />
                <span class="tp-name">{p.typed}</span>
                <span class={cx('small', p.exact ? 'muted' : 'tp-unknown')}>{p.exact ? 'as typed · Danbooru tag' : 'as typed · not a Danbooru tag'}</span>
              </label>
              {p.hits.map((h) => (
                <label key={h.tag} class={cx('tp-opt', p.choice === h.prompt && 'on')} title={h.wiki ?? undefined}>
                  <input type="radio" name={`tp-${i}`} checked={p.choice === h.prompt} onChange={() => choose(i, h.prompt)} />
                  <span class="tp-name">{h.prompt}</span>
                  <span class="muted small">{h.category !== 'general' ? `${h.category} · ` : ''}{posts(h.posts)}</span>
                </label>
              ))}
              {!p.hits.length && <p class="muted small">No similar tags found.</p>}
            </fieldset>
          </li>
        ))}
      </ol>
      <div class="dialog-actions tp-actions">
        <button type="button" class="btn" onClick={onClose}>Cancel</button>
        <button type="button" class="btn btn-primary" onClick={() => onApply(picks)}>
          {thenRun ? `Generate ${batch} image${batch > 1 ? 's' : ''}` : changed ? `Replace ${changed} tag${changed > 1 ? 's' : ''}` : 'Keep as typed'}
        </button>
      </div>
    </Sheet>
  );
}
