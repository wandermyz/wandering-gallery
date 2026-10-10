import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { api, ApiError, fileUrl, type Asset, type CaptionAction, type CaptionResponse, type Dataset, type DatasetConflict, type DatasetMode, type DatasetResult, type MetadataResponse, type Scalar, type Summary } from './api';
import { CopyButton, Icon, IconButton, Spinner } from './ui';
import { CAPTION_EVENT, CAPTION_LABELS, cx, formatBytes, formatDate, formatDuration } from './util';

function Section({ title, defaultOpen = true, children, extra }: { title: string; defaultOpen?: boolean; children: ComponentChildren; extra?: ComponentChildren }) {
  const key = `wg.sec.${title}`;
  const [open, setOpen] = useState(() => {
    const v = localStorage.getItem(key);
    return v === null ? defaultOpen : v === '1';
  });
  return (
    <section class={cx('section', open && 'open')}>
      <div class="section-head">
        <button
          type="button"
          class="section-toggle"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
            localStorage.setItem(key, open ? '0' : '1');
          }}
        >
          <Icon name="next" size={16} class="chev" />
          <span>{title}</span>
        </button>
        {extra}
      </div>
      {open && <div class="section-body">{children}</div>}
    </section>
  );
}

function KV({ rows }: { rows: [string, ComponentChildren][] }) {
  const shown = rows.filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!shown.length) return null;
  return (
    <dl class="kv">
      {shown.map(([k, v]) => (
        <div class="kv-row" key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function fmt(v: Scalar | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v === 'number' && !Number.isInteger(v)) return String(Math.round(v * 1000) / 1000);
  return String(v);
}

function PromptBlock({ label, texts, tone }: { label: string; texts: string[]; tone: 'pos' | 'neg' | 'other' }) {
  if (!texts.length) return null;
  const all = texts.join('\n\n');
  return (
    <div class={cx('prompt', `prompt-${tone}`)}>
      <div class="prompt-head">
        <span class="prompt-label">{label}</span>
        <CopyButton text={all} />
      </div>
      {texts.map((t, i) => (
        <p class="prompt-text" key={i}>{t}</p>
      ))}
    </div>
  );
}

const PARAM_LABELS: Record<string, string> = {
  seed: 'Seed', steps: 'Steps', cfg: 'CFG', sampler: 'Sampler', scheduler: 'Scheduler', denoise: 'Denoise',
  width: 'Latent width', height: 'Latent height', batch_size: 'Batch size', frames: 'Frames', fps: 'FPS',
  shift: 'Shift', guidance: 'Guidance', upscale_by: 'Upscale by',
};

function Generation({ s }: { s: Summary }) {
  const params = Object.entries(s.params);
  const multi = s.samplers.length > 1;
  return (
    <>
      <PromptBlock label="Positive prompt" texts={s.positive} tone="pos" />
      <PromptBlock label="Negative prompt" texts={s.negative} tone="neg" />
      <PromptBlock label="Other text inputs" texts={s.otherText} tone="other" />
      {params.length > 0 && (
        <div class="params">
          {params.map(([k, v]) => (
            <div class="param" key={k}>
              <span class="param-k">{PARAM_LABELS[k] ?? k}</span>
              <span class="param-v">{fmt(v)}</span>
              {k === 'seed' && <CopyButton text={String(v)} label="" />}
            </div>
          ))}
        </div>
      )}
      {(s.models.length > 0 || s.loras.length > 0) && (
        <div class="models">
          {s.models.map((m, i) => (
            <div class="model" key={`m${i}`}>
              <span class="tag">{m.kind}</span>
              <span class="model-name">{m.name}</span>
            </div>
          ))}
          {s.loras.map((l, i) => (
            <div class="model" key={`l${i}`}>
              <span class="tag tag-lora">LoRA</span>
              <span class="model-name">{l.name}</span>
              <span class="model-w">
                {l.strengthModel !== undefined ? fmt(l.strengthModel) : ''}
                {l.strengthClip !== undefined && l.strengthClip !== l.strengthModel ? ` / ${fmt(l.strengthClip)}` : ''}
              </span>
            </div>
          ))}
        </div>
      )}
      {multi && (
        <div class="samplers">
          <div class="sub-label">{s.samplers.length} sampler passes</div>
          {s.samplers.map((x, i) => (
            <div class="sampler" key={i}>
              <div class="sampler-title">
                {x.title && x.title !== x.classType ? `${x.title} · ` : ''}{x.classType}
                {x.nodeId ? <span class="muted"> #{x.nodeId}</span> : null}
              </div>
              <KV rows={[
                ['Seed', fmt(x.seed)], ['Steps', fmt(x.steps)], ['CFG', fmt(x.cfg)],
                ['Sampler', fmt(x.sampler)], ['Scheduler', fmt(x.scheduler)], ['Denoise', fmt(x.denoise)],
              ]} />
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function RawJson({ id, which, bytes }: { id: number; which: 'prompt' | 'workflow'; bytes: number }) {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [show, setShow] = useState(false);
  useEffect(() => {
    setText(null);
    setShow(false);
  }, [id]);
  const load = async () => {
    setShow(!show);
    if (text === null) {
      try {
        const raw = await api.raw(id, which);
        try {
          setText(JSON.stringify(JSON.parse(raw), null, 2));
        } catch {
          setText(raw);
        }
      } catch (e) {
        setErr((e as Error).message);
      }
    }
  };
  const label = which === 'prompt' ? 'API prompt JSON' : 'Workflow JSON';
  return (
    <div class="raw">
      <div class="raw-head">
        <button type="button" class="chip-btn" onClick={load} aria-expanded={show}>
          <Icon name={show ? 'close' : 'next'} size={14} /> {show ? 'Hide' : 'Show'} {label}
          <span class="muted">{formatBytes(bytes)}</span>
        </button>
        <CopyButton text={() => api.raw(id, which)} />
        <a class="chip-btn" href={`/api/assets/${id}/raw/${which}?download=1`} download>
          <Icon name="download" size={14} /> Save
        </a>
      </div>
      {show && (err ? <p class="error-text">{err}</p> : text === null ? <Spinner /> : <pre class="json no-gesture">{text}</pre>)}
    </div>
  );
}

const tagsOf = (s: string) => s.split(',').map((t) => t.trim()).filter(Boolean);

/** Tag-level diff of the current caption against a candidate. */
function TagDiff({ from, to }: { from: string; to: string }) {
  const a = tagsOf(from);
  const b = tagsOf(to);
  const inA = new Set(a);
  const inB = new Set(b);
  return (
    <p class="tag-diff">
      {b.map((t, i) => <span key={`b${i}`} class={cx(!inA.has(t) && 'diff-add')}>{t}</span>)}
      {a.filter((t) => !inB.has(t)).map((t, i) => <span key={`a${i}`} class="diff-del">{t}</span>)}
    </p>
  );
}

function scalarText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function CaptionSection({ asset: a }: { asset: Asset }) {
  const [cap, setCap] = useState<CaptionResponse | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const capRef = useRef<CaptionResponse | null>(null);
  const draftRef = useRef('');
  capRef.current = cap;
  draftRef.current = draft;
  const dirty = !!cap && draft !== (cap.txt ?? '');

  const apply = (c: CaptionResponse) => {
    setCap(c);
    setDraft(c.txt ?? '');
    setStale(false);
  };
  const load = () =>
    api.caption(a.id).then(apply, (e) => setError((e as Error).message));

  useEffect(() => {
    setCap(null);
    setError(null);
    setNotice(null);
    setShowRaw(false);
    void load();
  }, [a.id]);

  // External change (pipeline, other tab): reload unless that would throw away an edit.
  useEffect(() => {
    const on = (ev: Event) => {
      if (!(ev as CustomEvent<number[]>).detail.includes(a.id) || busy) return;
      const c = capRef.current;
      if (c && draftRef.current !== (c.txt ?? '')) setStale(true);
      else void load();
    };
    window.addEventListener(CAPTION_EVENT, on);
    return () => window.removeEventListener(CAPTION_EVENT, on);
  }, [a.id, busy]);

  const act = async (action: CaptionAction, extra: { caption?: string; approve?: boolean } = {}) => {
    if (!cap || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      apply(await api.captionAction(a.id, action, cap, extra));
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setNotice((e as Error).message);
        await load();
      } else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (error && !cap) return <p class="error-text">Could not load caption: {error}</p>;
  // Most media has no caption sidecars: show nothing rather than an empty editor.
  if (!cap || (cap.txt === null && !cap.json && !cap.jsonError)) return null;

  const j = cap.json;
  const ro = !cap.writable;
  const cand = j?.candidate && typeof j.candidate === 'object' ? j.candidate : null;
  const classification = j?.classification && typeof j.classification === 'object' ? Object.entries(j.classification) : [];
  const gen = j?.generation;
  const status = cap.status ?? (cap.txt === null ? null : 'edited');

  return (
    <Section
      title="Caption"
      extra={status && <span class={cx('cap-pill', `cap-${status}`)}>{CAPTION_LABELS[status] ?? status}</span>}
    >
      {ro && <p class="muted cap-note"><Icon name="lock" size={12} /> This library is read-only, so the caption cannot be edited.</p>}
      {cap.jsonError && <p class="error-text cap-note">The caption json cannot be read: {cap.jsonError}</p>}
      {notice && <p class="cap-note cap-warn">{notice}</p>}
      {stale && (
        <p class="cap-note cap-warn">
          The caption changed on disk.{' '}
          <button type="button" class="chip-btn" onClick={() => void load()}>Discard my edit and reload</button>
        </p>
      )}
      {error && <p class="error-text cap-note">{error}</p>}
      <textarea
        class="cap-text no-gesture"
        value={draft}
        placeholder={cap.txt === null ? 'No caption yet' : ''}
        rows={4}
        readOnly={ro}
        disabled={busy}
        spellcheck={false}
        onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && dirty) {
            e.preventDefault();
            void act('save', { caption: draft });
          }
        }}
      />
      {!ro && (
        <div class="cap-actions">
          <button type="button" class="btn btn-sm" disabled={busy || !dirty || !draft.trim()} onClick={() => void act('save', { caption: draft })}>Save</button>
          {dirty ? (
            <button type="button" class="btn btn-sm btn-primary" disabled={busy || !draft.trim()} onClick={() => void act('save', { caption: draft, approve: true })}>Save &amp; approve</button>
          ) : (
            <button type="button" class="btn btn-sm btn-primary" disabled={busy || cap.txt === null || status === 'approved'} onClick={() => void act('approve')}>Approve</button>
          )}
          <button type="button" class="btn btn-sm" disabled={busy || dirty || status === 'needs_regen'} onClick={() => void act('needs_regen')}
            title="Ask the pipeline to regenerate this caption">Regenerate</button>
        </div>
      )}
      {cand && (
        <div class="prompt prompt-other cap-cand">
          <div class="prompt-head">
            <span class="prompt-label">Candidate{cand.generation?.model ? ` · ${cand.generation.model}` : ''}</span>
          </div>
          {typeof cand.caption === 'string' && <TagDiff from={cap.txt ?? ''} to={cand.caption} />}
          {typeof cand.description === 'string' && <p class="prompt-text muted">{cand.description}</p>}
          {!ro && (
            <div class="cap-actions pad-x">
              <button type="button" class="btn btn-sm btn-primary" disabled={busy || dirty} onClick={() => void act('accept_candidate')}>Accept</button>
              <button type="button" class="btn btn-sm" disabled={busy} onClick={() => void act('discard_candidate')}>Discard</button>
            </div>
          )}
        </div>
      )}
      {typeof j?.description === 'string' && j.description && (
        <div class="prompt prompt-other">
          <div class="prompt-head">
            <span class="prompt-label">Description</span>
            <CopyButton text={j.description} />
          </div>
          <p class="prompt-text">{j.description}</p>
        </div>
      )}
      {classification.length > 0 && <KV rows={classification.map(([k, v]) => [k.replace(/_/g, ' '), scalarText(v)])} />}
      {(j?.raw?.output || gen) && (
        <div class="raw cap-raw">
          <div class="raw-head">
            <button type="button" class="chip-btn" onClick={() => setShowRaw(!showRaw)} aria-expanded={showRaw}>
              <Icon name={showRaw ? 'close' : 'next'} size={14} /> {showRaw ? 'Hide' : 'Show'} model output
            </button>
          </div>
          {showRaw && (
            <>
              {gen && <KV rows={[
                ['Model', scalarText(gen.model)],
                ['Revision', scalarText(gen.revision).slice(0, 12)],
                ['Created', gen.created_at ? formatDate(Date.parse(gen.created_at)) : undefined],
                ['Pipeline', scalarText(gen.pipeline_version)],
              ]} />}
              {typeof j?.raw?.output === 'string' && <pre class="json no-gesture">{j.raw.output}</pre>}
            </>
          )}
        </div>
      )}
    </Section>
  );
}

const MODE_KEY = 'wg.datasetMode';
const LAST_KEY = 'wg.dataset';

/** "Add to dataset": pick (or type a new) dataset and copy or move the file there with its sidecars. */
function DatasetPicker({ asset: a, onDone, onClose }: { asset: Asset; onDone: (r: DatasetResult) => void; onClose: () => void }) {
  const canMove = a.writable !== false;
  const [mode, setMode] = useState<DatasetMode>(() => (localStorage.getItem(MODE_KEY) === 'copy' ? 'copy' : 'move'));
  const [list, setList] = useState<Dataset[] | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Name already taken in the chosen dataset: waiting for cancel / replace / keep both. */
  const [conflict, setConflict] = useState<{ dataset: string; create: boolean; existing: string[] } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const effMode: DatasetMode = canMove ? mode : 'copy';

  useEffect(() => {
    api.datasets().then((r) => setList(r.datasets), (e) => setError((e as Error).message));
    // Focusing would pop up the on-screen keyboard over the list on phones.
    if (window.matchMedia('(pointer: fine)').matches) input.current?.focus();
  }, []);

  const q = query.trim();
  const last = localStorage.getItem(LAST_KEY);
  const matches = (list ?? [])
    .filter((d) => d.name.toLowerCase().includes(q.toLowerCase()))
    .sort((x, y) => {
      const rank = (d: Dataset) => (q ? (d.name.toLowerCase().startsWith(q.toLowerCase()) ? 0 : 1) : d.name === last ? 0 : 1);
      return rank(x) - rank(y);
    });
  const validNew = !!q && !q.startsWith('.') && !/[/\\]/.test(q) && q.length <= 100;
  const canCreate = validNew && list !== null && !list.some((d) => d.name === q);
  const verb = effMode === 'move' ? 'Move' : 'Copy';

  const run = async (name: string, create: boolean, onConflict: DatasetConflict = 'ask') => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setConflict(null);
    try {
      const r = await api.addToDataset(a, name, effMode, create, onConflict);
      localStorage.setItem(LAST_KEY, r.dataset);
      onDone(r);
    } catch (e) {
      const c = e instanceof ApiError ? (e.data.conflict as { existing?: string[] } | undefined) : undefined;
      if (c) setConflict({ dataset: name, create, existing: c.existing ?? [] });
      else setError((e as Error).message);
      setBusy(false);
    }
  };

  if (conflict) {
    return (
      <div class="ds-picker" role="alertdialog" aria-label="File already exists">
        <div class="ds-conflict">
          <p><Icon name="alert" size={16} /> <strong class="break">{a.name}</strong> already exists in <strong>{conflict.dataset}</strong>.</p>
          {conflict.existing.some((n) => n !== a.name) && (
            <p class="muted">Existing: {conflict.existing.join(', ')}</p>
          )}
          <p class="muted">Replace moves the existing file and its captions to the trash.</p>
        </div>
        <div class="cap-actions">
          <button type="button" class="btn btn-sm" onClick={() => setConflict(null)}>Cancel</button>
          <button type="button" class="btn btn-sm btn-danger" onClick={() => void run(conflict.dataset, conflict.create, 'replace')}>Replace</button>
          <button type="button" class="btn btn-sm btn-primary" onClick={() => void run(conflict.dataset, conflict.create, 'rename')}>Keep both</button>
        </div>
      </div>
    );
  }

  return (
    <div class="ds-picker">
      <div class="seg" role="radiogroup" aria-label="Move or copy">
        {(['move', 'copy'] as const).map((m) => (
          <button
            type="button"
            key={m}
            role="radio"
            aria-checked={effMode === m}
            class={cx(effMode === m && 'on')}
            disabled={busy || (m === 'move' && !canMove)}
            onClick={() => {
              setMode(m);
              localStorage.setItem(MODE_KEY, m);
            }}
          >
            {m === 'move' ? 'Move' : 'Copy'}
          </button>
        ))}
      </div>
      {!canMove && <p class="muted cap-note ds-note"><Icon name="lock" size={12} /> This library is read-only, so the file can only be copied.</p>}
      <input
        ref={input}
        class="ds-input"
        type="text"
        value={query}
        placeholder="Find or create a dataset"
        aria-label="Dataset name"
        autocomplete="off"
        autocapitalize="off"
        spellcheck={false}
        disabled={busy}
        onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') onClose();
          else if (e.key === 'Enter') {
            e.preventDefault();
            const exact = matches.find((d) => d.name === q);
            if (exact || (!canCreate && matches[0])) void run((exact ?? matches[0]).name, false);
            else if (canCreate) void run(q, true);
          }
        }}
      />
      {error && <p class="error-text cap-note ds-note">{error}</p>}
      <div class="ds-list" role="listbox" aria-label="Datasets">
        {list === null && !error && <Spinner />}
        {matches.map((d) => (
          <button type="button" class="ds-item" key={d.name} disabled={busy} onClick={() => void run(d.name, false)}>
            <Icon name="folder" size={18} />
            <span class="ds-name">{d.name}</span>
            <span class="muted">{d.count.toLocaleString()}</span>
            <span class="ds-verb">{verb}</span>
          </button>
        ))}
        {canCreate && (
          <button type="button" class="ds-item ds-new" disabled={busy} onClick={() => void run(q, true)}>
            <Icon name="plus" size={18} />
            <span class="ds-name">Create “{q}”</span>
            <span class="ds-verb">{verb}</span>
          </button>
        )}
        {list !== null && !matches.length && !canCreate && (
          <p class="muted cap-note ds-note">{q ? 'Not a valid dataset name.' : 'No datasets yet. Type a name to create one.'}</p>
        )}
      </div>
      {busy && <Spinner label={effMode === 'move' ? 'Moving…' : 'Copying…'} />}
    </div>
  );
}

export function InfoPanel({ asset: a, onClose, onDataset }: { asset: Asset; onClose: () => void; onDataset?: (a: Asset, r: DatasetResult) => void }) {
  const [picking, setPicking] = useState(false);
  useEffect(() => setPicking(false), [a.id]);

  const [meta, setMeta] = useState<MetadataResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setMeta(null);
    setError(null);
    const load = () =>
      api.metadata(a.id).then(
        (m) => {
          if (!alive) return;
          setMeta(m);
          // Still being indexed: poll until it is ready.
          if (m.indexState === 'pending') setTimeout(() => alive && void load(), 1500);
        },
        (e) => alive && setError((e as Error).message),
      );
    void load();
    return () => {
      alive = false;
    };
  }, [a.id, a.v]);

  const s = meta?.summary;
  const extras = meta ? Object.entries(meta.extra) : [];

  return (
    <aside class="info no-gesture" aria-label="Details">
      <div class="info-head">
        <h2>Details</h2>
        <IconButton icon="close" label="Close details" onClick={onClose} />
      </div>
      <div class="info-scroll">
        {a.status === 'ready' && <CaptionSection asset={a} />}
        {error && <p class="error-text">Could not load metadata: {error}</p>}
        {!meta && !error && <Spinner label="Loading metadata" />}
        {meta && meta.indexState === 'pending' && <p class="muted pad">Reading metadata…</p>}
        {meta && meta.indexState === 'error' && (
          <p class="error-text">Metadata could not be read: {meta.indexError}</p>
        )}

        {meta && meta.indexState !== 'pending' && (
          <>
            {s ? (
              <Section title={s.source === 'a1111' ? 'Generation (A1111)' : 'Generation'}>
                <Generation s={s} />
              </Section>
            ) : (
              !meta.hasPrompt && !meta.hasWorkflow && !meta.parameters && (
                <div class="empty-meta">
                  <Icon name="info" size={20} />
                  <p>No generation metadata found in this file.</p>
                </div>
              )
            )}

            {s && s.nodeTypes.length > 0 && (
              <Section title={`Nodes (${s.nodeTypes.length})`} defaultOpen={false}>
                <div class="node-types">
                  {s.nodeTypes.map((t) => <span class="tag" key={t}>{t}</span>)}
                </div>
              </Section>
            )}

            {(meta.hasPrompt || meta.hasWorkflow || meta.parameters) && (
              <Section title="Raw metadata" defaultOpen={!s}>
                {!s && <p class="muted">The workflow could not be interpreted automatically; the original data is below.</p>}
                {meta.hasPrompt && <RawJson id={a.id} which="prompt" bytes={meta.promptBytes} />}
                {meta.hasWorkflow && <RawJson id={a.id} which="workflow" bytes={meta.workflowBytes} />}
                {meta.parameters && (
                  <div class="prompt prompt-other">
                    <div class="prompt-head">
                      <span class="prompt-label">parameters</span>
                      <CopyButton text={meta.parameters} />
                    </div>
                    <p class="prompt-text">{meta.parameters}</p>
                  </div>
                )}
              </Section>
            )}

            {extras.length > 0 && (
              <Section title="Other embedded text" defaultOpen={false}>
                {extras.map(([k, v]) => (
                  <div class="prompt prompt-other" key={k}>
                    <div class="prompt-head">
                      <span class="prompt-label">{k}</span>
                      <CopyButton text={v} />
                    </div>
                    <p class="prompt-text clamp">{v}</p>
                  </div>
                ))}
              </Section>
            )}
          </>
        )}
        <Section title="File" defaultOpen={!a.hasMeta}>
          <KV rows={[
            ['Name', <span class="break">{a.name}</span>],
            ['Folder', a.folder ? <span class="break">{a.folder}</span> : '(library root)'],
            ['Library', a.libraryName ?? a.library],
            ['Modified', formatDate(a.mtimeMs)],
            ['Size', formatBytes(a.size)],
            ['Dimensions', a.width && a.height ? `${a.width} × ${a.height}` : undefined],
            ['Duration', a.duration ? formatDuration(a.duration) : undefined],
            ['Codec', a.videoCodec ? `${a.videoCodec}${a.audioCodec ? ` + ${a.audioCodec}` : ''}` : undefined],
            ['Type', a.mime + (a.animated ? ' (animated)' : '')],
          ]} />
          <div class="file-actions">
            <a class="chip-btn" href={`${fileUrl(a)}&download=1`} download={a.name}><Icon name="download" size={14} /> Download</a>
            <a class="chip-btn" href={fileUrl(a)} target="_blank" rel="noopener"><Icon name="external" size={14} /> Open original</a>
            <CopyButton text={a.path} label="Copy path" />
          </div>
        </Section>

        {a.status === 'ready' && onDataset && (
          <Section title="Dataset">
            {picking ? (
              <DatasetPicker
                asset={a}
                onClose={() => setPicking(false)}
                onDone={(r) => {
                  setPicking(false);
                  onDataset(a, r);
                }}
              />
            ) : (
              <button type="button" class="btn btn-sm btn-block ds-open" onClick={() => setPicking(true)}>
                <Icon name="plus" size={16} /> Add to dataset
              </button>
            )}
          </Section>
        )}

      </div>
    </aside>
  );
}
