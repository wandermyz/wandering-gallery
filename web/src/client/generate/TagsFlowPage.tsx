import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { ApiError, thumbUrl } from '../gallery/api';
import { ConfirmDialog, Icon, IconButton, Spinner, Toasts, type ConfirmOptions, type ToastMsg } from '../common/ui';
import { cx, formatDate } from '../common/util';
import { goTo } from '../shell/router';
import { genApi, type FlowInfo, type Job, type Run } from './api';

const MAX_VARIATIONS = 12;
const MAX_BATCH = 16;

/** Finished images may take a few seconds to be indexed; keep polling for them this long. */
const INDEX_WAIT_MS = 60_000;

// Page state lives in memory outside the component, so it survives switching to the
// gallery (e.g. to view an image) and back, but not a reload. Setters keep working while
// the page is not shown, so tag requests and runs that finish meanwhile are not lost.
const kept = new Map<string, unknown>();
let tagQueue: Promise<unknown> = Promise.resolve();

function useKept<T>(key: string, init: T): [T, (v: T | ((cur: T) => T)) => void] {
  if (!kept.has(key)) kept.set(key, init);
  const [value, setValue] = useState(kept.get(key) as T);
  const set = useCallback((v: T | ((cur: T) => T)) => {
    const next = typeof v === 'function' ? (v as (cur: T) => T)(kept.get(key) as T) : v;
    kept.set(key, next);
    setValue(next);
  }, [key]);
  return [value, set];
}

const norm = (tags: string) => tags.split(',').map((t) => t.trim()).filter(Boolean).join(', ');

const unindexed = (r: Run) => r.jobs.some((j) => j.status === 'completed' && j.outputs.some((o) => !o.asset));

export function TagsFlowPage({ flow, onComfyDown }: { flow: FlowInfo; onComfyDown: () => void }) {
  const k = (name: string) => `${flow.id}:${name}`;
  const [prompt, setPrompt] = useKept(k('prompt'), '');
  const [variations, setVariations] = useKept<string[]>(k('variations'), [flow.defaultTags]);
  const [batch, setBatch] = useKept(k('batch'), 3);
  /** Indexes of variations whose tags are being generated. */
  const [generating, setGenerating] = useKept<Set<number>>(k('generating'), new Set());
  const [runs, setRuns] = useKept<Run[]>(k('runs'), []);
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

  // The server only knows the runs still being worked on (e.g. started before a reload);
  // finished ones stay on the page until it is reloaded.
  useEffect(() => {
    genApi.runs().then((r) => setRuns((rs) => [...r.runs.filter((x) => x.flow === flow.id && !rs.some((y) => y.id === x.id)), ...rs]), () => {});
  }, [flow.id]);
  const active = runs.some((r) => r.status === 'running' || (unindexed(r) && Date.now() - (r.finishedAtMs ?? 0) < INDEX_WAIT_MS));
  useEffect(() => {
    if (!active) return;
    const t = setInterval(async () => {
      const fresh = await Promise.all(runs.filter((r) => r.status === 'running' || unindexed(r)).map((r) => genApi.run(r.id).catch(() => null)));
      const byId = new Map(fresh.filter((r): r is Run => !!r).map((r) => [r.id, r]));
      setRuns((rs) => rs.map((r) => byId.get(r.id) ?? r));
    }, 1500);
    return () => clearInterval(t);
  }, [active, runs]);

  /** Variations with nothing beyond the prefilled quality and LoRA tags. */
  const blank = (v: string) => !v.trim() || norm(v) === norm(flow.defaultTags);
  const empty = variations.map((v, i) => (blank(v) && !generating.has(i) ? i : -1)).filter((i) => i >= 0);
  const canTag = !!prompt.trim() && flow.ready;
  const busyTags = generating.size > 0;

  /** Variation 1 is the description as-is; the others ask for a distinct character. */
  const generateTags = (index: number) => {
    const text = prompt.trim();
    setGenerating((g) => new Set(g).add(index));
    // One request at a time, as ComfyUI would run them anyway.
    tagQueue = tagQueue.then(async () => {
      try {
        const { tags } = await genApi.tags(flow.id, text, index > 0);
        setVariations((vs) => vs.map((v, i) => (i === index ? tags : v)));
      } catch (e) {
        onError(`Variation ${index + 1}: ${(e as Error).message}`, e);
      } finally {
        setGenerating((g) => {
          const n = new Set(g);
          n.delete(index);
          return n;
        });
      }
    });
  };

  const setCount = (n: number) => {
    n = Math.min(MAX_VARIATIONS, Math.max(1, n));
    setVariations((vs) => (n > vs.length ? [...vs, ...Array<string>(n - vs.length).fill(flow.defaultTags)] : vs.slice(0, n)));
  };

  const fillTags = async () => {
    if (empty.length) {
      empty.forEach(generateTags);
      return;
    }
    const ok = await ask({ title: 'Regenerate all tags?', message: <p>Every variation, including your edits, is replaced.</p>, confirm: 'Regenerate' });
    if (ok) variations.forEach((_, i) => generateTags(i));
  };

  const removeVariation = (index: number) => {
    setVariations((vs) => (vs.length > 1 ? vs.filter((_, i) => i !== index) : [flow.defaultTags]));
  };

  const start = async () => {
    setStarting(true);
    try {
      const run = await genApi.start(flow.id, prompt.trim(), variations.map((v) => v.trim()), batch);
      setRuns((rs) => [run, ...rs]);
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
    setPrompt(run.prompt);
    setVariations(run.variations);
    setBatch(run.batch);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const tagLabel = !empty.length ? 'Regenerate all' : empty.length === variations.length ? 'Generate tags' : `Generate ${empty.length} more`;
  const total = variations.length * batch;
  // Tags may be typed by hand, so the description is optional.
  const canRun = flow.ready && variations.every((v) => v.trim()) && !busyTags && !starting;

  return (
    <div class="gen">
      <section class="gen-card">
        <label class="gen-label" for="gen-prompt">Description <span class="muted">中文 / English</span></label>
        <textarea id="gen-prompt" class="cap-text gen-prompt" rows={3} value={prompt} placeholder="Describe the image (中文 / English)"
          onInput={(e) => setPrompt(e.currentTarget.value)} />
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
              <IconButton icon="refresh" label={`Regenerate variation ${i + 1}`} disabled={!canTag || generating.has(i)} onClick={() => generateTags(i)} />
              <IconButton icon="close" label={`Remove variation ${i + 1}`} disabled={busyTags || (variations.length === 1 && blank(v))} onClick={() => removeVariation(i)} />
            </div>
            {generating.has(i) ? (
              <Spinner label="Generating tags…" />
            ) : (
              <textarea class="cap-text gen-tags" rows={3} value={v} aria-label={`Tags for variation ${i + 1}`}
                placeholder="Danbooru tags, comma separated: generate them or type them here"
                onInput={(e) => {
                  const text = e.currentTarget.value;
                  setVariations((vs) => vs.map((x, j) => (j === i ? text : x)));
                }} />
            )}
          </li>
        ))}
      </ol>

      <section class="gen-card gen-row gen-go">
        <Stepper label="Images per variation" value={batch} min={1} max={MAX_BATCH} onChange={setBatch} />
        <button type="button" class="btn btn-primary" disabled={!canRun} onClick={() => void start()}>
          {starting ? <span class="spinner spinner-sm" /> : <Icon name="play" size={16} />}
          Generate {total} image{total > 1 ? 's' : ''}
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
      {run.prompt && <p class="gen-run-prompt break">{run.prompt}</p>}
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
