import { useCallback, useRef, useState } from 'preact/hooks';
import { ApiError, thumbUrl, type Asset } from '../gallery/api';
import { Icon, Toasts, type ToastMsg } from '../common/ui';
import { cx, formatDate } from '../common/util';
import { genApi, type FlowInfo, type Run } from './api';
import { JobCell, RUN_STATUS, Stepper, useKept, useRunUpdates } from './TagsFlowPage';

const MAX_VIDEO_BATCH = 4;

/**
 * Image + prompt → video. The image is picked in the gallery: the viewer's "Copy path"
 * button, then Paste here (or paste/type the path into the field).
 */
export function VideoFlowPage({ flow, onComfyDown }: { flow: FlowInfo; onComfyDown: () => void }) {
  const k = (name: string) => `${flow.id}:${name}`;
  const seconds = flow.seconds ?? [5];
  const [path, setPath] = useKept(k('path'), '');
  const [image, setImage] = useKept<Asset | null>(k('image'), null);
  const [prompt, setPrompt] = useKept(k('prompt'), '');
  const [length, setLength] = useKept(k('seconds'), flow.defaultSeconds ?? seconds[0]);
  const [batch, setBatch] = useKept(k('batch'), 1);
  const [runs, setRuns] = useKept<Run[]>(k('runs'), []);
  const [pathError, setPathError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const toastId = useRef(0);
  /** The latest lookup; an older one finishing late must not overwrite it. */
  const pickSeq = useRef(0);

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

  /** Looks the path up in the gallery and shows the image. */
  const pick = async (raw: string) => {
    const p = raw.trim().replace(/^(['"])(.*)\1$/, '$2');
    const seq = ++pickSeq.current;
    setPath(p);
    setPathError(null);
    if (!p) {
      setImage(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const { asset } = await genApi.videoImage(p);
      if (seq === pickSeq.current) setImage(asset);
    } catch (e) {
      if (seq !== pickSeq.current) return;
      setImage(null);
      setPathError((e as Error).message);
    } finally {
      if (seq === pickSeq.current) setLoading(false);
    }
  };

  const paste = async () => {
    try {
      await pick(await navigator.clipboard.readText());
    } catch {
      // Clipboard reads need permission (and a secure context); the field still takes a paste.
      setPathError('Could not read the clipboard. Paste into the field instead.');
    }
  };

  const start = async () => {
    if (!image) return;
    setStarting(true);
    try {
      const run = await genApi.startVideo(flow.id, path, prompt.trim(), length, batch);
      setRuns((rs) => [run, ...rs]);
      toast(`Queued ${run.jobs.length} video${run.jobs.length > 1 ? 's' : ''}`);
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
    if (run.video) {
      setLength(run.video.seconds);
      void pick(run.video.sourcePath);
    }
    setBatch(run.jobs.length);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const canRun = flow.ready && !!image && !!prompt.trim() && !starting && !loading;

  return (
    <div class="gen">
      <section class="gen-card">
        <label class="gen-label" for="vid-path">Input image <span class="muted">first frame</span></label>
        <div class="vid-path-row">
          <input id="vid-path" class="cap-text vid-path" type="text" value={path} spellcheck={false} autocomplete="off"
            placeholder="Copy path in the gallery viewer, then Paste"
            onChange={(e) => void pick(e.currentTarget.value)}
            onKeyDown={(e) => e.key === 'Enter' && void pick(e.currentTarget.value)} />
          <button type="button" class="btn" onClick={() => void paste()}><Icon name="copy" size={18} />Paste</button>
        </div>
        {pathError && <p class="vid-error" role="alert">{pathError}</p>}
        {loading && <div class="vid-preview vid-preview-ph"><span class="spinner spinner-sm" /></div>}
        {!loading && image && (
          <figure class="vid-preview">
            <img src={thumbUrl(image)} alt={image.name} style={image.width && image.height ? { aspectRatio: `${image.width} / ${image.height}` } : undefined} />
            <figcaption class="muted small">{image.name}{image.width && image.height ? ` · ${image.width}×${image.height}` : ''}</figcaption>
          </figure>
        )}
      </section>

      <section class="gen-card">
        <label class="gen-label" for="vid-prompt">Prompt <span class="muted">shots, motion, dialogue and sound</span></label>
        <textarea id="vid-prompt" class="cap-text gen-prompt vid-prompt" rows={6} value={prompt}
          placeholder={'What happens in the video, e.g.\n[0s-2s] The cat looks up and blinks slowly.\n[2s-5s] It says "Hello!" in a cute voice.\nAudio: soft room ambience, light piano.'}
          onInput={(e) => setPrompt(e.currentTarget.value)} />
        <div class="gen-label vid-len-label" id="vid-len">Length</div>
        <div class="seg" role="radiogroup" aria-labelledby="vid-len">
          {seconds.map((s) => (
            <button key={s} type="button" role="radio" aria-checked={s === length} class={cx(s === length && 'on')} onClick={() => setLength(s)}>{s} s</button>
          ))}
        </div>
      </section>

      <section class="gen-card gen-row gen-go">
        <Stepper label="Videos" value={batch} min={1} max={MAX_VIDEO_BATCH} onChange={setBatch} />
        <button type="button" class="btn btn-primary" disabled={!canRun} onClick={() => void start()}>
          {starting ? <span class="spinner spinner-sm" /> : <Icon name="play" size={16} />}
          Generate {batch > 1 ? `${batch} videos` : 'video'}
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
      {runs.map((run) => <VideoRunCard key={run.id} run={run} onCancel={() => void cancel(run)} onReuse={() => reuse(run)} />)}

      <Toasts toasts={toasts} dismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
    </div>
  );
}

function VideoRunCard({ run, onCancel, onReuse }: { run: Run; onCancel: () => void; onReuse: () => void }) {
  const done = run.jobs.filter((j) => j.status === 'completed').length;
  const source = run.video?.sourcePath.split('/').pop();
  return (
    <section class="gen-card gen-run" aria-label={`Run ${formatDate(run.createdAtMs)}`}>
      <div class="gen-run-head">
        <div class="gen-run-title">
          <span class={cx('cap-pill', `run-${run.status}`)}>{RUN_STATUS[run.status]}</span>
          <span class="muted small">{formatDate(run.createdAtMs)} · {run.video ? `${run.video.seconds} s · ` : ''}{done}/{run.jobs.length}</span>
        </div>
        {run.status === 'running' && <button type="button" class="btn btn-sm" onClick={onCancel}>Cancel</button>}
        <button type="button" class="btn btn-sm" onClick={onReuse} title="Put this image, prompt and length back into the form">Reuse</button>
      </div>
      {source && <p class="gen-run-tags break" title={run.video!.sourcePath}><span class="muted">From</span> {source}</p>}
      <p class="gen-run-prompt break vid-run-prompt">{run.prompt}</p>
      <div class="gen-thumbs vid-thumbs">
        {run.jobs.map((j) => <JobCell key={j.index} job={j} />)}
      </div>
    </section>
  );
}
