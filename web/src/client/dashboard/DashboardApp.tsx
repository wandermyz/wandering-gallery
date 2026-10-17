import type { ComponentChildren } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { ConfirmDialog, Icon, Spinner, Toasts, type ConfirmOptions, type ToastMsg } from '../common/ui';
import { cx, formatDuration } from '../common/util';
import { thumbUrl } from '../gallery/api';
import { goTo } from '../shell/router';
import { SectionPage } from '../shell/SectionPage';
import { dashApi, type Dashboard, type DashJob, type GpuSample, type Workload } from './api';

/** How often the page refreshes while it is on screen. */
const POLL_MS = 3_000;

let toastSeq = 0;

/** /dashboard: ComfyUI's queue and the GPU; jobs can be cancelled. Polls while the page is visible. */
export default function DashboardApp() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [confirm, setConfirm] = useState<{ opts: ConfirmOptions; resolve: (ok: boolean) => void } | null>(null);
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  /** Jobs with a cancel request in flight. */
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(new Set());

  const load = useCallback(async () => {
    try {
      setData(await dashApi.get());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let alive = true;
    const tick = async () => {
      timer = null;
      if (document.visibilityState !== 'visible') return;
      await load();
      if (alive && !timer) timer = setTimeout(() => void tick(), POLL_MS);
    };
    const onVis = () => {
      if (document.visibilityState === 'visible' && !timer) void tick();
    };
    void tick();
    document.addEventListener('visibilitychange', onVis);
    // Elapsed times tick between refreshes.
    const clock = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      clearInterval(clock);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [load]);

  const toast = useCallback((text: string, opts: Partial<ToastMsg> = {}) => {
    const id = ++toastSeq;
    setToasts((t) => [...t.slice(-2), { id, text, ...opts }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);
  const ask = (opts: ConfirmOptions) => new Promise<boolean>((resolve) => setConfirm({ opts, resolve }));

  const cancel = async (job: DashJob) => {
    const running = job.status === 'running';
    const ok = await ask({
      title: running ? 'Stop this job?' : 'Remove this job from the queue?',
      message: (
        <p class="muted">
          <b>{jobName(job)}</b>{job.flow ? ' was queued from Generate.' : ' was not queued from this app.'}
          {running ? ' Whatever it has made so far is discarded.' : ''}
        </p>
      ),
      confirm: running ? 'Stop job' : 'Remove job',
      danger: true,
    });
    if (!ok) return;
    setCancelling((s) => new Set(s).add(job.id));
    try {
      await dashApi.cancel(job.id);
      toast(running ? 'Job stopped' : 'Job removed from the queue');
      await load();
    } catch (e) {
      toast(`Cancel failed: ${(e as Error).message}`, { kind: 'error' });
    } finally {
      setCancelling((s) => {
        const n = new Set(s);
        n.delete(job.id);
        return n;
      });
    }
  };

  const c = data?.comfy;
  const sub = !data ? undefined
    : !c!.online ? 'ComfyUI offline'
    : c!.running.length ? `ComfyUI busy · ${c!.pending.length} queued`
    : 'ComfyUI idle';

  return (
    <SectionPage title="Dashboard" sub={sub} drawerTitle="Dashboard"
      nav={<p class="muted small drawer-note">ComfyUI's queue, the GPU and who holds it. Refreshes every few seconds.</p>}>
      {error && (
        <div class="banner banner-error" role="alert">
          <Icon name="alert" size={20} /><span>{error}</span>
          <button type="button" class="btn btn-sm" onClick={() => void load()}>Retry</button>
        </div>
      )}
      {!data && !error && <Spinner />}
      {data && (
        <div class="dash">
          <div class="dash-gpu">
            <GpuCard gpu={data.gpu} />
            {data.workload && <WorkloadCard workload={data.workload} />}
          </div>
          <ComfyCard comfy={data.comfy} now={now} cancelling={cancelling} onCancel={(j) => void cancel(j)} />
        </div>
      )}
      <ConfirmDialog opts={confirm?.opts ?? null} onResult={(ok) => { confirm?.resolve(ok); setConfirm(null); }} />
      <Toasts toasts={toasts} dismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
    </SectionPage>
  );
}

// ---- ComfyUI -------------------------------------------------------------------

function ComfyCard({ comfy, now, cancelling, onCancel }: { comfy: Dashboard['comfy']; now: number; cancelling: ReadonlySet<string>; onCancel: (j: DashJob) => void }) {
  return (
    <section class="gen-card dash-card dash-comfy" aria-labelledby="dash-comfy-h">
      <div class="dash-head">
        <h2 id="dash-comfy-h">ComfyUI</h2>
        {comfy.online
          ? <span class={cx('cap-pill', comfy.running.length ? 'run-running' : 'run-completed')}>{comfy.running.length ? 'Running' : 'Idle'}</span>
          : <span class="cap-pill run-error">Offline</span>}
      </div>
      {!comfy.online && <p class="dash-err"><Icon name="alert" size={16} /><span class="break">{comfy.error}</span></p>}
      {comfy.online && (
        <>
          {comfy.running.map((j) => <RunningJob key={j.id} job={j} now={now} cancel={<CancelButton job={j} busy={cancelling.has(j.id)} onCancel={onCancel} />} />)}
          {!comfy.running.length && <p class="muted dash-none">Nothing running.</p>}

          <h3 class="dash-h3">Queued <span class="muted">{comfy.pending.length}</span></h3>
          {comfy.pending.length
            ? (
              <ol class="dash-jobs">
                {comfy.pending.map((j, i) => (
                  <li key={j.id} class="dash-job">
                    <span class="dash-job-n">{i + 1}</span>
                    <JobName job={j} />
                    <span class="dash-job-t muted">{j.createdAtMs ? `${ago(now - j.createdAtMs)} ago` : ''}</span>
                    <CancelButton job={j} busy={cancelling.has(j.id)} onCancel={onCancel} />
                  </li>
                ))}
              </ol>
            )
            : <p class="muted dash-none">The queue is empty.</p>}

          <h3 class="dash-h3">Recent</h3>
          {comfy.recent.length
            ? <ul class="dash-jobs">{comfy.recent.map((j) => <RecentJob key={j.id} job={j} now={now} />)}</ul>
            : <p class="muted dash-none">No finished jobs since ComfyUI started.</p>}
        </>
      )}
    </section>
  );
}

const jobName = (job: DashJob) => job.title ?? job.output?.filename.replace(/_?\d*_?\.\w+$/, '') ?? 'Job';

function JobName({ job }: { job: DashJob }) {
  const name = jobName(job);
  const by = job.flow ? 'gallery' : job.clientId ? clientLabel(job.clientId) : null;
  return (
    <span class="dash-job-name">
      <span class="dash-job-title">{name}</span>
      {(job.model || by) && <span class="muted small dash-job-meta">{[job.model, by].filter(Boolean).join(' · ')}</span>}
    </span>
  );
}

/** "comfy-render-9b7e2e04" → "comfy-render"; the ComfyUI page's random ids → "ComfyUI". */
function clientLabel(id: string): string {
  if (/^[0-9a-f]{32}$/.test(id)) return 'ComfyUI';
  return id.replace(/-[0-9a-f-]{6,}$/i, '') || id;
}

function CancelButton({ job, busy, onCancel }: { job: DashJob; busy: boolean; onCancel: (j: DashJob) => void }) {
  return (
    <button type="button" class="btn btn-sm dash-cancel" disabled={busy} aria-label={`Cancel ${jobName(job)}`} onClick={() => onCancel(job)}>
      {busy ? 'Cancelling…' : 'Cancel'}
    </button>
  );
}

function RunningJob({ job, now, cancel }: { job: DashJob; now: number; cancel: ComponentChildren }) {
  const elapsed = job.startedAtMs ? Math.max(0, now - job.startedAtMs) : null;
  return (
    <div class="dash-running">
      <div class="dash-running-row">
        <span class="spinner spinner-sm" aria-hidden="true" />
        <JobName job={job} />
        <span class="dash-elapsed" title="Running for (estimated)">{elapsed !== null ? formatDuration(elapsed / 1000) : ''}</span>
        {cancel}
      </div>
      {job.progress !== null
        ? (
          <div class="meter" role="progressbar" aria-label="Sampler progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(job.progress * 100)}>
            <div style={{ width: `${job.progress * 100}%` }} />
          </div>
        )
        : <div class="meter meter-busy" aria-hidden="true"><div /></div>}
      <p class="muted small dash-note">
        {job.progress !== null ? `${Math.round(job.progress * 100)}% of the sampler steps`
          : 'ComfyUI only reports step progress to the app that queued a job.'}
      </p>
    </div>
  );
}

function RecentJob({ job, now }: { job: DashJob; now: number }) {
  const took = job.startedAtMs && job.endedAtMs ? (job.endedAtMs - job.startedAtMs) / 1000 : null;
  const a = job.output?.asset;
  const href = a && `/gallery?lib=${encodeURIComponent(a.library)}${job.output!.subfolder ? `&folder=${encodeURIComponent(job.output!.subfolder)}` : ''}&a=${a.id}`;
  return (
    <li class={cx('dash-job', `dash-${job.status}`)}>
      {a && href
        ? (
          <a class="dash-thumb" href={href} aria-label={job.output!.filename} onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            e.preventDefault();
            goTo(href, { state: { viewer: true } });
          }}>
            <img src={thumbUrl(a)} alt="" loading="lazy" />
          </a>
        )
        : <span class="dash-thumb dash-thumb-ph"><Icon name={job.status === 'completed' ? 'image' : 'alert'} size={18} /></span>}
      <span class="dash-job-name">
        <span class="dash-job-title break">{job.output?.filename ?? (job.status === 'completed' ? 'No output' : statusLabel(job.status))}</span>
        {job.error
          ? <span class="small dash-job-error break">{job.error}</span>
          : <span class="muted small">{statusLabel(job.status)}{took !== null ? ` · ${formatDuration(took)}` : ''}</span>}
      </span>
      <span class="dash-job-t muted">{job.endedAtMs ? `${ago(now - job.endedAtMs)} ago` : ''}</span>
    </li>
  );
}

const statusLabel = (s: DashJob['status']) => ({ pending: 'Queued', running: 'Running', completed: 'Done', failed: 'Failed', cancelled: 'Cancelled' })[s];

/** A short age: 45 s, 12 min, 3 h, 2 d. */
function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

// ---- GPU -----------------------------------------------------------------------

function GpuCard({ gpu }: { gpu: Dashboard['gpu'] }) {
  const s = gpu.now;
  return (
    <section class="gen-card dash-card" aria-labelledby="dash-gpu-h">
      <div class="dash-head">
        <h2 id="dash-gpu-h">GPU</h2>
        {s && <span class="muted small dash-head-sub">{s.name.replace(/^NVIDIA /, '')}</span>}
      </div>
      {gpu.error && <p class="dash-err"><Icon name="alert" size={16} /><span class="break">{gpu.error}</span></p>}
      {s && (
        <>
          <div class="dash-stats">
            <Stat label="Load" value={`${s.util}%`} />
            <Stat label="VRAM" value={gib(s.memUsedMib)} unit={`/ ${gib(s.memTotalMib)} GB`} />
            {s.tempC !== null && <Stat label="Temp" value={`${s.tempC}°`} unit="C" />}
            {s.powerW !== null && <Stat label="Power" value={`${Math.round(s.powerW)}`} unit={s.powerLimitW ? `/ ${Math.round(s.powerLimitW)} W` : 'W'} />}
          </div>
          <Sparkline samples={gpu.history} />
        </>
      )}
    </section>
  );
}

function Stat({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div class="dash-stat">
      <span class="dash-stat-label">{label}</span>
      <span class="dash-stat-value">{value}{unit && <span class="dash-stat-unit"> {unit}</span>}</span>
    </div>
  );
}

const gib = (mib: number) => (mib / 1024).toFixed(1);

const SPARK_W = 600;
const SPARK_H = 72;

/** GPU load over the last minutes, with a hover/touch readout. */
function Sparkline({ samples }: { samples: GpuSample[] }) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  if (samples.length < 2) return <p class="muted small dash-note">Load history appears after a few readings.</p>;
  const t0 = samples[0].atMs;
  const span = Math.max(1, samples.at(-1)!.atMs - t0);
  const x = (s: GpuSample) => ((s.atMs - t0) / span) * SPARK_W;
  const y = (s: GpuSample) => SPARK_H - 2 - (s.util / 100) * (SPARK_H - 4);
  const line = samples.map((s) => `${x(s).toFixed(1)},${y(s).toFixed(1)}`).join(' ');
  const h = hover !== null ? samples[hover] : null;
  const onMove = (e: PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const at = t0 + ((e.clientX - r.left) / r.width) * span;
    let best = 0;
    for (let i = 1; i < samples.length; i++) if (Math.abs(samples[i].atMs - at) < Math.abs(samples[best].atMs - at)) best = i;
    setHover(best);
  };
  const minutes = Math.round(span / 60_000);
  return (
    <figure class="dash-spark">
      <figcaption class="muted small">
        {h ? <><b class="dash-spark-val">{h.util}%</b> load · {new Date(h.atMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</>
          : <>Load, last {minutes ? `${minutes} min` : `${Math.round(span / 1000)} s`}</>}
      </figcaption>
      <svg ref={ref} viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none" role="img"
        aria-label={`GPU load over the last ${minutes || 1} minutes, now ${samples.at(-1)!.util}%`}
        onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)}>
        <line class="dash-spark-grid" x1="0" x2={SPARK_W} y1={SPARK_H / 2} y2={SPARK_H / 2} />
        <polygon class="dash-spark-area" points={`0,${SPARK_H} ${line} ${SPARK_W},${SPARK_H}`} />
        <polyline class="dash-spark-line" points={line} />
        {h && <line class="dash-spark-cursor" x1={x(h)} x2={x(h)} y1="0" y2={SPARK_H} />}
      </svg>
    </figure>
  );
}

// ---- GPU workload ----------------------------------------------------------------

const MODES: Record<string, { label: string; cls: string; hint: string }> = {
  comfy: { label: 'ComfyUI', cls: 'run-running', hint: 'ComfyUI may load models; the LLM is unloaded.' },
  strata: { label: 'Strata', cls: 'run-completed', hint: 'The local LLM is loaded; ComfyUI holds no models.' },
  none: { label: 'Free', cls: '', hint: 'Nothing holds the GPU; whichever side asks next loads.' },
  conflict: { label: 'Conflict', cls: 'run-error', hint: 'Both hold the GPU. The next switch sorts it out.' },
};

function WorkloadCard({ workload }: { workload: NonNullable<Dashboard['workload']> }) {
  const w = workload.status;
  const mode = w && (MODES[w.mode] ?? { label: w.mode, cls: '', hint: '' });
  return (
    <section class="gen-card dash-card" aria-labelledby="dash-wl-h">
      <div class="dash-head">
        <h2 id="dash-wl-h">GPU workload</h2>
        {mode && (
          <span class={cx('cap-pill', mode.cls)}>
            {w!.mode === 'conflict' && <Icon name="alert" size={12} class="dash-pill-icon" />}{mode.label}
          </span>
        )}
      </div>
      {workload.error && <p class="dash-err"><Icon name="alert" size={16} /><span class="break">{workload.error}</span></p>}
      {w && (
        <>
          {mode?.hint && <p class="muted small dash-note">{mode.hint}</p>}
          <VramSplit gpu={w.gpu} />
          <dl class="dash-dl">
            <dt>Strata</dt><dd>{strataState(w)}</dd>
            <dt>ComfyUI</dt><dd>{comfyState(w)}</dd>
            {w.last_event && (
              <>
                <dt>Last</dt>
                <dd>{eventText(w.last_event)} <span class="muted">· {new Date(w.last_event.time).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span></dd>
              </>
            )}
          </dl>
        </>
      )}
    </section>
  );
}

function strataState(w: Workload) {
  if (!w.strata.service) return 'Service stopped';
  if (!w.strata.reachable) return 'Service up, not answering';
  return w.strata.loaded ? 'Model loaded' : 'Model unloaded';
}

function comfyState(w: Workload) {
  if (!w.comfy.service) return 'Service stopped';
  if (!w.comfy.reachable) return 'Service up, not answering';
  return `${w.comfy.holds_models ? 'Models loaded' : 'No models loaded'} · ${w.comfy.running} running, ${w.comfy.pending} queued`;
}

function eventText(ev: NonNullable<Workload['last_event']>) {
  if (ev.event === 'switch') return `Switched to ${ev.to}${ev.ok === false ? ' (failed)' : ''}`;
  if (ev.event === 'strata-load') return `LLM load ${ev.allowed ? 'allowed' : 'refused'}${ev.reason ? `: ${String(ev.reason)}` : ''}`;
  return ev.event;
}

/** Who holds the VRAM: one stacked bar, labelled below (identity is never color alone). */
function VramSplit({ gpu }: { gpu: Workload['gpu'] }) {
  if (gpu.error || !gpu.total_mib) return <p class="dash-err"><Icon name="alert" size={16} /><span>{gpu.error ?? 'No VRAM reading'}</span></p>;
  const total = gpu.total_mib;
  const parts = [
    { key: 'strata', label: 'Strata', mib: gpu.strata_mib },
    { key: 'comfy', label: 'ComfyUI', mib: gpu.comfy_mib },
    { key: 'other', label: 'Other', mib: gpu.other_mib },
  ];
  const free = gpu.free_mib ?? Math.max(0, total - parts.reduce((n, p) => n + p.mib, 0));
  return (
    <div class="vram">
      <div class="vram-bar" role="img" aria-label={`VRAM: ${parts.map((p) => `${p.label} ${gib(p.mib)} GB`).join(', ')}, free ${gib(free)} of ${gib(total)} GB`}>
        {parts.filter((p) => p.mib > 0).map((p) => (
          <div key={p.key} class={`vram-seg vram-${p.key}`} style={{ width: `${(p.mib / total) * 100}%` }} title={`${p.label}: ${gib(p.mib)} GB`} />
        ))}
      </div>
      <ul class="vram-legend">
        {parts.map((p) => (
          <li key={p.key}><span class={`vram-key vram-${p.key}`} />{p.label} <b>{gib(p.mib)}</b></li>
        ))}
        <li><span class="vram-key vram-free" />Free <b>{gib(free)}</b> <span class="muted">/ {gib(total)} GB</span></li>
      </ul>
    </div>
  );
}
