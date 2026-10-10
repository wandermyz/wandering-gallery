import { useCallback, useEffect, useState } from 'preact/hooks';
import { Icon, Spinner } from '../common/ui';
import { cx } from '../common/util';
import { SectionPage } from '../shell/SectionPage';
import { goTo, usePathname } from '../shell/router';
import { genApi, type ComfyStatus, type FlowInfo } from './api';
import { TagsFlowPage } from './TagsFlowPage';

/** /generate/<flow>: one page per generation flow. */
export default function GenerateApp() {
  const pathname = usePathname();
  const [flows, setFlows] = useState<FlowInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [comfy, setComfy] = useState<ComfyStatus | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      setComfy(await genApi.status());
    } catch {
      /* shown by the next attempt */
    }
  }, []);
  const load = useCallback(async () => {
    try {
      setFlows((await genApi.flows()).flows);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
    void loadStatus();
  }, [loadStatus]);
  useEffect(() => void load(), [load]);
  // Re-check while ComfyUI is down, so the banner clears once it is started.
  useEffect(() => {
    if (comfy?.online !== false) return;
    const t = setInterval(() => void loadStatus(), 10_000);
    return () => clearInterval(t);
  }, [comfy?.online, loadStatus]);

  const id = pathname.split('/')[2] ?? '';
  const flow = flows?.find((f) => f.id === id) ?? null;
  // A single flow for now: /generate opens it.
  useEffect(() => {
    if (flows?.length && !flow) goTo(`/generate/${flows[0].id}`, { replace: true });
  }, [flows, flow]);

  const nav = (close: () => void) => flows && (
    <div class="lib-list">
      {flows.map((f) => (
        <a key={f.id} href={`/generate/${f.id}`} class={cx('lib-item', f.id === id && 'active')}
          onClick={(e) => {
            e.preventDefault();
            close();
            if (f.id !== id) goTo(`/generate/${f.id}`);
          }}>
          <Icon name="sparkle" size={20} />
          <span class="lib-name">{f.title}</span>
          {!f.ready && <span class="lib-err">setup</span>}
        </a>
      ))}
    </div>
  );

  return (
    <SectionPage title={flow?.title ?? 'Generate'} sub={comfy ? (comfy.online ? `ComfyUI · ${comfy.devices[0]?.name.replace(/ : .*$/, '') ?? 'online'}` : 'ComfyUI offline') : undefined}
      drawerTitle="Workflows" nav={nav}>
      {error && (
        <div class="banner banner-error">
          <Icon name="alert" size={20} /><span>{error}</span>
          <button type="button" class="btn btn-sm" onClick={() => void load()}>Retry</button>
        </div>
      )}
      {comfy && !comfy.online && (
        <div class="banner banner-error" role="alert">
          <Icon name="alert" size={20} />
          <span>{comfy.error ?? `ComfyUI is not reachable at ${comfy.url}.`}</span>
          <button type="button" class="btn btn-sm" onClick={() => void loadStatus()}>Check again</button>
        </div>
      )}
      {flow && !flow.ready && (
        <div class="banner banner-error">
          <Icon name="alert" size={20} />
          <span class="break">{flow.problem}</span>
          <button type="button" class="btn btn-sm" onClick={() => void load()}>Check again</button>
        </div>
      )}
      {!flows && !error && <Spinner />}
      {flow && <TagsFlowPage key={flow.id} flow={flow} onComfyDown={() => void loadStatus()} />}
    </SectionPage>
  );
}
