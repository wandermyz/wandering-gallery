import { HttpError } from '../paths.js';
import { ProcError, run } from '../proc.js';

/** A Danbooru tag found by a search. */
export interface TagHit {
  /** As Danbooru names it: `hatsune_miku_(cosplay)`. */
  tag: string;
  /** As it goes into a prompt: `hatsune miku \(cosplay\)`. */
  prompt: string;
  category: string;
  posts: number;
  wiki: string | null;
}

/** Description → Danbooru tags. Tests substitute a fake. */
export interface Tagger {
  /** The tags, comma separated, without quality tags. */
  tags(description: string): Promise<string>;
  /** The k closest tags for each query, best first. No LLM, no GPU. */
  search(queries: string[], k: number): Promise<Record<string, TagHit[]>>;
}

/** danbooru-tagger's prompt form: underscores to spaces (not in emoticons like ^_^), brackets escaped. */
export function promptTag(name: string): string {
  return (name.length > 3 ? name.replaceAll('_', ' ') : name).replace(/[()]/g, (c) => `\\${c}`);
}

/** Hands the GPU between the local LLM (Strata) and ComfyUI. Tests substitute a fake. */
export interface Gpu {
  /** Makes sure ComfyUI has the GPU; call before queueing any ComfyUI job. */
  toComfy(): Promise<void>;
}

/** Cuts a tool's stdout/stderr to the message worth showing. */
function failure(e: unknown, cmd: string, setting: string): HttpError {
  if ((e as NodeJS.ErrnoException).code === 'ENOENT') return new HttpError(`${cmd} not found ("${cmd}"); set ${setting} in the config`, 500);
  if (e instanceof ProcError) {
    try {
      const out = JSON.parse(e.stdout.trim().split('\n').pop() ?? '') as { error?: string };
      if (out.error) return new HttpError(`${cmd}: ${out.error}`, 502);
    } catch {
      /* not JSON */
    }
  }
  return new HttpError((e as Error).message, 502);
}

/**
 * danbooru-tagger (RAG over the Danbooru tag set with the local LLM). It claims the
 * GPU for Strata itself, waiting for ComfyUI's queue to drain first, and leaves
 * Strata loaded so the next description is fast.
 *
 * Its embedder and tag index need well over a GB of RAM. Under systemd it runs in its
 * own scope, outside the service's MemoryHigh, which would otherwise throttle it to a
 * crawl.
 */
export class CliTagger implements Tagger {
  constructor(private readonly cli: string) {}

  private exec(args: string[], timeoutMs: number) {
    const [cmd, argv] = process.env.INVOCATION_ID
      ? ['systemd-run', ['--user', '--scope', '--quiet', '--collect', '--', this.cli, ...args]]
      : [this.cli, args];
    return run(cmd, argv, { timeoutMs, maxBytes: 4 * 1024 * 1024 }).then((r) => r.stdout.toString());
  }

  async tags(description: string) {
    let stdout: string;
    try {
      // Up to 600 s for ComfyUI's queue to drain plus 600 s for tagging.
      stdout = await this.exec(['tag', '--json', '--quality', '', '-q', '--', description], 25 * 60_000);
    } catch (e) {
      if (e instanceof ProcError && e.code === 4) throw new HttpError(`danbooru-tagger could not get the GPU: ${e.message.replace(/^.*?: /, '')}`, 503);
      throw failure(e, this.cli, 'generate.tagger');
    }
    const out = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as { ok?: boolean; positive?: string; error?: string };
    if (!out.ok || !out.positive?.trim()) throw new HttpError(`danbooru-tagger: ${out.error ?? 'no tags'}`, 502);
    return out.positive.trim();
  }

  /** One process for all queries: loading the index takes a few seconds. */
  async search(queries: string[], k: number) {
    let stdout: string;
    try {
      stdout = await this.exec(['search', '--json', '-k', String(k), '--', ...queries], 2 * 60_000);
    } catch (e) {
      throw failure(e, this.cli, 'generate.tagger');
    }
    let out: Record<string, { tag: string; category: string; posts: number; wiki?: string }[]>;
    try {
      out = JSON.parse(stdout);
    } catch {
      throw new HttpError('danbooru-tagger search: unreadable output', 502);
    }
    return Object.fromEntries(queries.map((q) => [q, (out[q] ?? []).map((h) => ({
      tag: h.tag, prompt: promptTag(h.tag), category: h.category, posts: h.posts, wiki: h.wiki ?? null,
    }))]));
  }
}

/** `gpu-workload switch comfy`: idempotent, about 1 s when Strata has to be unloaded. */
export class CliGpu implements Gpu {
  constructor(private readonly cli: string) {}

  async toComfy() {
    try {
      // --wait lets an answer Strata is in the middle of finish.
      await run(this.cli, ['switch', 'comfy', '--wait', '120', '--json'], { timeoutMs: 5 * 60_000, maxBytes: 1024 * 1024 });
    } catch (e) {
      const err = failure(e, this.cli, 'generate.gpuWorkload');
      throw new HttpError(`Could not hand the GPU to ComfyUI. ${err.message}`, err.status === 500 ? 500 : 503);
    }
  }
}
