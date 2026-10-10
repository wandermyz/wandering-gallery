import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { api, fileUrl, type Asset, type MetadataResponse, type Scalar, type Summary } from './api';
import { CopyButton, Icon, IconButton, Spinner } from './ui';
import { cx, formatBytes, formatDate, formatDuration } from './util';

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

export function InfoPanel({ asset: a, onClose }: { asset: Asset; onClose: () => void }) {
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

      </div>
    </aside>
  );
}
