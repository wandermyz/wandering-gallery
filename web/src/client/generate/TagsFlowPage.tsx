import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { ApiError, thumbUrl } from '../gallery/api';
import { ConfirmDialog, Icon, IconButton, Spinner, Toasts, type ConfirmOptions, type ToastMsg } from '../common/ui';
import { cx, formatDate } from '../common/util';
import { goTo } from '../shell/router';
import { genApi, type FlowInfo, type Job, type Run } from './api';

const MAX_VARIATIONS = 12;
const MAX_BATCH = 16;

// ---- Draft: survives leaving the page (localStorage) and keeps tag requests that
// finish while the page is not mounted.

interface Draft {
  prompt: string;
  variations: string[];
  batch: number;
}

const draftKey = (flow: string) => `wg:generate:${flow}`;

function loadDraft(flow: string): Draft {
  try {
    const d = JSON.parse(localStorage.getItem(draftKey(flow)) ?? '') as Partial<Draft>;
    const variations = Array.isArray(d.variations) ? d.variations.filter((v) => typeof v === 'string').slice(0, MAX_VARIATIONS) : [];
    return {
      prompt: typeof d.prompt === 'string' ? d.prompt : '',
      variations: variations.length ? variations : [''],
      batch: Number.isInteger(d.batch) ? Math.min(MAX_BATCH, Math.max(1, d.batch!)) : 3,
    };
  } catch {
    return { prompt: '', variations: [''], batch: 3 };
  }
}

const drafts = new Map<string, Draft>();
/** Indexes of variations whose tags are being generated, per flow. */
const busy = new Map<string, Set<number>>();
const listeners = new Set<() => void>();

function getDraft(flow: string): Draft {
  if (!drafts.has(flow)) drafts.set(flow, loadDraft(flow));
  return drafts.get(flow)!;
}

function setDraft(flow: string, patch: Partial<Draft> | ((d: Draft) => Partial<Draft>)) {
  const cur = getDraft(flow);
  const next = { ...cur, ...(typeof patch === 'function' ? patch(cur) : patch) };
  drafts.set(flow, next);
  try {
    localStorage.setItem(draftKey(flow), JSON.stringify(next));
  } catch {
    /* private mode */
  }
  for (const l of listeners) l();
}

function useDraft(flow: string): [Draft, Set<number>] {
  const [, force] = useState(0);
  useEffect(() => {
    const on = () => force((n) => n + 1);
    listeners.add(on);
    return () => void listeners.delete(on);
  }, []);
  if (!busy.has(flow)) busy.set(flow, new Set());
  return [getDraft(flow), busy.get(flow)!];
}

/**
 * Generates tags for one variation. Variation 1 is the description as-is; the others
 * ask for a distinct character. Requests run one after another, like ComfyUI does.
 */
let tagQueue: Promise<unknown> = Promise.resolve();
function generateTags(flow: string, index: number, onError: (msg: string, e: unknown) => void) {
  const set = busy.get(flow)!;
  if (set.has(index)) return;
  const prompt = getDraft(flow).prompt.trim();
  set.add(index);
  setDraft(flow, {});
  tagQueue = tagQueue.then(async () => {
    try {
      const { tags } = await genApi.tags(flow, prompt, index > 0);
      // The variation may have been removed meanwhile (index beyond the list).
      setDraft(flow, (d) => (index < d.variations.length ? { variations: d.variations.map((v, i) => (i === index ? tags : v)) } : {}));
    } catch (e) {
      onError(`Variation ${index + 1}: ${(e as Error).message}`, e);
    } finally {
      set.delete(index);
      setDraft(flow, {});
    }
  });
}

// ---- Page --------------------------------------------------------------------------

export function TagsFlowPage({ flow, onComfyDown }: { flow: FlowInfo; onComfyDown: () => void }) {
  const [draft, generating] = useDraft(flow.id);
  const [runs, setRuns] = useState<Run[]>([]);
  const [starting, setStarting] = useState(false);
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const [confirm, setConfirm] = useState<{ opts: ConfirmOptions; resolve: (ok: boolean) => void } | null>(null);
  const toastId = useRef(0);

  const toast = useCallback((text: string, kind: 'error' | 'info' = 'info') => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 3500);
  }, []);
  const ask = (opts: ConfirmOptions) => new Promise<boolean>((resolve) => setConfirm({ opts, resolve }));
  const onError = useCallback((msg: string, e?: unknown) => {
    if (e instanceof ApiError && e.status === 503) onComfyDown();
    toast(msg, 'error');
  }, [toast, onComfyDown]);

  // Runs: poll while one is active, or while finished images are still being indexed.
  const loadRuns = useCallback(async () => {
    try {
      setRuns((await genApi.runs()).runs.filter((r) => r.flow === flow.id));
    } catch {
      /* keep the last list */
    }
  }, [flow.id]);
  useEffect(() => void loadRuns(), [loadRuns]);
  const active = runs.some((r) => r.status === 'running' ||
    (Date.now() - (r.finishedAtMs ?? 0) < 60_000 && r.jobs.some((j) => j.status === 'completed' && j.outputs.some((o) => !o.asset))));
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void loadRuns(), 1500);
    return () => clearInterval(t);
  }, [active, loadRuns]);

  const { prompt, variations, batch } = draft;
  const empty = variations.map((v, i) => (!v.trim() && !generating.has(i) ? i : -1)).filter((i) => i >= 0);
  const canTag = !!prompt.trim() && flow.ready;
  const busyTags = generating.size > 0;

  const setCount = (n: number) => {
    n = Math.min(MAX_VARIATIONS, Math.max(1, n));
    setDraft(flow.id, (d) => ({ variations: n > d.variations.length ? [...d.variations, ...Array(n - d.variations.length).fill('')] : d.variations.slice(0, n) }));
  };

  const fillTags = async () => {
    if (empty.length) {
      for (const i of empty) generateTags(flow.id, i, onError);
      return;
    }
    const ok = await ask({ title: 'Regenerate all tags?', message: <p>Every variation, including your edits, is replaced.</p>, confirm: 'Regenerate' });
    if (ok) variations.forEach((_, i) => generateTags(flow.id, i, onError));
  };

  const removeVariation = (index: number) => {
    if (generating.size) return;
    setDraft(flow.id, (d) => ({ variations: d.variations.length > 1 ? d.variations.filter((_, i) => i !== index) : [''] }));
  };

  const start = async () => {
    setStarting(true);
    try {
      const run = await genApi.start(flow.id, prompt.trim(), variations.map((v) => v.trim()), batch);
      setRuns((rs) => [run, ...rs.filter((r) => r.id !== run.id)]);
      toast(`Queued ${run.jobs.length} image${run.jobs.length > 1 ? 's' : ''}`);
    } catch (e) {
      onError((e as Error).message, e);
    } finally {
      setStarting(false);
    }
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
    setDraft(flow.id, { prompt: run.prompt, variations: run.variations, batch: run.batch });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const tagLabel = !empty.length ? 'Regenerate all' : empty.length === variations.length ? 'Generate tags' : `Generate ${empty.length} more`;
  const total = variations.length * batch;
  const canRun = flow.ready && !!prompt.trim() && variations.every((v) => v.trim()) && !busyTags && !starting;

  return (
    <div class="gen">
      <section class="gen-card">
        <label class="gen-label" for="gen-prompt">Description <span class="muted">中文 / English</span></label>
        <textarea id="gen-prompt" class="cap-text gen-prompt" rows={3} value={prompt} placeholder="Describe the image (中文 / English)"
          onInput={(e) => setDraft(flow.id, { prompt: e.currentTarget.value })} />
        <div class="gen-row">
          <Stepper label="Tag variations" value={variations.length} min={1} max={MAX_VARIATIONS} onChange={setCount} disabled={busyTags} />
          <button type="button" class="btn btn-primary" disabled={!canTag || busyTags} onClick={() => void fillTags()}>
            <Icon name="sparkle" size={18} />{tagLabel}
          </button>
        </div>
      </section>

      <ol class="gen-vars">
        {variations.map((v, i) => (
          <li key={i} class="gen-card gen-var">
            <div class="gen-var-head">
              <span class="gen-label">Variation {i + 1}{i === 0 && <span class="muted"> · as described</span>}</span>
              <IconButton icon="refresh" label={`Regenerate variation ${i + 1}`} disabled={!canTag || generating.has(i)} onClick={() => generateTags(flow.id, i, onError)} />
              <IconButton icon="close" label={`Remove variation ${i + 1}`} disabled={busyTags || (variations.length === 1 && !v)} onClick={() => removeVariation(i)} />
            </div>
            {generating.has(i) ? (
              <Spinner label="Generating tags…" />
            ) : (
              <textarea class="cap-text gen-tags" rows={3} value={v} aria-label={`Tags for variation ${i + 1}`}
                placeholder={canTag ? 'Generate tags, or type them here' : 'Danbooru tags, comma separated'}
                onInput={(e) => {
                  const text = e.currentTarget.value;
                  setDraft(flow.id, (d) => ({ variations: d.variations.map((x, j) => (j === i ? text : x)) }));
                }} />
            )}
          </li>
        ))}
      </ol>

      <section class="gen-card gen-row gen-go">
        <Stepper label="Images per variation" value={batch} min={1} max={MAX_BATCH} onChange={(n) => setDraft(flow.id, { batch: n })} />
        <button type="button" class="btn btn-primary" disabled={!canRun} onClick={() => void start()}>
          {starting ? <span class="spinner spinner-sm" /> : <Icon name="play" size={16} />}
          Generate {total} image{total > 1 ? 's' : ''}
        </button>
      </section>

      {runs.length > 0 && <h2 class="gen-h2">Runs</h2>}
      {runs.map((run) => <RunCard key={run.id} run={run} onCancel={() => void cancel(run)} onReuse={() => reuse(run)} />)}

      <ConfirmDialog opts={confirm?.opts ?? null} onResult={(ok) => { confirm?.resolve(ok); setConfirm(null); }} />
      <Toasts toasts={toasts} dismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
    </div>
  );
}

function Stepper({ label, value, min, max, onChange, disabled }: {
  label: string; value: number; min: number; max: number; onChange: (n: number) => void; disabled?: boolean;
}) {
  return (
    <div class="stepper" role="group" aria-label={label}>
      <span class="stepper-label">{label}</span>
      <div class="stepper-ctl">
        <IconButton icon="minus" label={`Fewer ${label.toLowerCase()}`} disabled={disabled || value <= min} onClick={() => onChange(value - 1)} />
        <output aria-live="polite">{value}</output>
        <IconButton icon="plus" label={`More ${label.toLowerCase()}`} disabled={disabled || value >= max} onClick={() => onChange(value + 1)} />
      </div>
    </div>
  );
}

const RUN_STATUS: Record<Run['status'], string> = { running: 'Running', completed: 'Done', error: 'Finished with errors', cancelled: 'Cancelled' };

function RunCard({ run, onCancel, onReuse }: { run: Run; onCancel: () => void; onReuse: () => void }) {
  const done = run.jobs.filter((j) => j.status === 'completed').length;
  return (
    <section class="gen-card gen-run" aria-label={`Run ${formatDate(run.createdAtMs)}`}>
      <div class="gen-run-head">
        <div class="gen-run-title">
          <span class={cx('cap-pill', `run-${run.status}`)}>{RUN_STATUS[run.status]}</span>
          <span class="muted small">{formatDate(run.createdAtMs)} · {done}/{run.jobs.length}</span>
        </div>
        {run.status === 'running' && <button type="button" class="btn btn-sm" onClick={onCancel}>Cancel</button>}
        <button type="button" class="btn btn-sm" onClick={onReuse} title="Put this description and these tags back into the form">Reuse</button>
      </div>
      <p class="gen-run-prompt break">{run.prompt}</p>
      {run.variations.map((tags, v) => (
        <div key={v} class="gen-run-var">
          <p class="gen-run-tags break" title={tags}><span class="muted">V{v + 1}</span> {tags}</p>
          <div class="gen-thumbs">
            {run.jobs.filter((j) => j.variation === v).map((j) => <JobCell key={`${j.variation}-${j.index}`} job={j} />)}
          </div>
        </div>
      ))}
    </section>
  );
}

function JobCell({ job }: { job: Job }) {
  const out = job.outputs[0];
  if (out?.asset) {
    const a = out.asset;
    const url = `/gallery?lib=${encodeURIComponent(a.library)}${out.subfolder ? `&folder=${encodeURIComponent(out.subfolder)}` : ''}&a=${a.id}`;
    return (
      <a class="gen-thumb" href={url} aria-label={out.filename} style={a.width && a.height ? { aspectRatio: `${a.width} / ${a.height}` } : undefined}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
          e.preventDefault();
          // Marked as a viewer entry: closing the viewer goes back here.
          goTo(url, { state: { viewer: true } });
        }}>
        <img src={thumbUrl(a)} alt="" loading="lazy" />
      </a>
    );
  }
  const label = job.status === 'completed' ? (out ? 'Indexing…' : 'No image')
    : job.status === 'running' ? `${Math.round(job.progress * 100)}%`
    : job.status === 'error' ? 'Failed' : job.status === 'cancelled' ? 'Cancelled' : 'Queued';
  return (
    <div class={cx('gen-thumb', 'gen-thumb-ph', `job-${job.status}`)} title={job.error ?? label}>
      {job.status === 'error' && <Icon name="alert" size={20} />}
      <span>{label}</span>
      {job.status === 'running' && <div class="gen-progress"><div style={{ width: `${job.progress * 100}%` }} /></div>}
    </div>
  );
}
