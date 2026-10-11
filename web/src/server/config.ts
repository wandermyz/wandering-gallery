import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

export interface LibraryConfig {
  id: string;
  name: string;
  path: string;
  recursive: boolean;
  writable: boolean;
  /** Include this library in the cross-library views (All media, Favorites). */
  showInAll: boolean;
}

export interface AppConfig {
  server: {
    host: string;
    port: number;
    /** Extra Host header names (besides localhost) allowed to reach the app, e.g. a tailnet hostname. */
    allowedHosts: string[];
  };
  /** SQLite database and trash live here. */
  dataDir: string;
  /** Thumbnails and previews live here; safe to delete at any time. */
  cacheDir: string;
  libraries: LibraryConfig[];
  scan: {
    /** A file must be unchanged for this long before it is indexed or deletable. */
    stableSeconds: number;
    /** Periodic safety-net rescan; 0 disables. File watching handles normal changes. */
    intervalMinutes: number;
    /** Use polling instead of inotify (for network filesystems). */
    usePolling: boolean;
  };
  trash: {
    retentionDays: number;
  };
  datasets: {
    /** Every first-level folder here is a training dataset. */
    root: string;
    /** Folder inside a dataset that holds its media ('' for the dataset folder itself). */
    subfolder: string;
  };
  thumbnails: {
    size: number;
    quality: number;
  };
  tools: {
    ffmpeg: string;
    ffprobe: string;
  };
  generate: GenerateConfig;
}

export interface GenerateConfig {
  /** Base URL of the ComfyUI server. */
  comfyui: string;
  /** comfy-cli executable. */
  comfyCli: string;
  /** Library that holds ComfyUI's output folder (to show results), or null. */
  outputLibrary: string | null;
  /** Workflow templates (API + UI JSON); defaults to the repo's comfyui/workflows. */
  workflowsDir: string;
  /** Local prompt files (never in git), one `<flow>.yaml` per flow. */
  promptsDir: string;
}

export class ConfigError extends Error {}

// Same depth from src/server and dist/server: <repo>/comfyui/workflows.
const REPO_WORKFLOWS = fileURLToPath(new URL('../../../comfyui/workflows', import.meta.url));

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function defaultConfigPath(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'wandering-gallery', 'config.yaml');
}

function asObject(v: unknown, where: string): Record<string, unknown> {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new ConfigError(`${where} must be a mapping`);
  return v as Record<string, unknown>;
}

function str(v: unknown, where: string, fallback?: string): string {
  if (v === undefined || v === null) {
    if (fallback !== undefined) return fallback;
    throw new ConfigError(`${where} is required`);
  }
  if (typeof v !== 'string' || v.trim() === '') throw new ConfigError(`${where} must be a non-empty string`);
  return v;
}

function bool(v: unknown, where: string, fallback: boolean): boolean {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'boolean') throw new ConfigError(`${where} must be true or false`);
  return v;
}

function num(v: unknown, where: string, fallback: number, min: number, max: number): number {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    throw new ConfigError(`${where} must be a number between ${min} and ${max}`);
  }
  return v;
}

/** Validates a parsed config object. Relative paths resolve against `baseDir`. */
export function parseConfig(raw: unknown, baseDir = process.cwd()): AppConfig {
  const root = asObject(raw, 'config');
  const resolvePath = (p: string) => path.resolve(baseDir, expandHome(p));

  const server = asObject(root.server, 'server');
  const scan = asObject(root.scan, 'scan');
  const trash = asObject(root.trash, 'trash');
  const thumbs = asObject(root.thumbnails, 'thumbnails');
  const tools = asObject(root.tools, 'tools');
  const datasets = asObject(root.datasets, 'datasets');
  const generate = asObject(root.generate, 'generate');
  const subfolder = datasets.subfolder === '' ? '' : str(datasets.subfolder, 'datasets.subfolder', 'images');
  if (subfolder && !/^[^/\\.][^/\\]*$/.test(subfolder)) throw new ConfigError('datasets.subfolder must be a single folder name');

  if (!Array.isArray(root.libraries) || root.libraries.length === 0) {
    throw new ConfigError('libraries must be a non-empty list');
  }
  const seen = new Set<string>();
  const libraries = root.libraries.map((entry, i): LibraryConfig => {
    const lib = asObject(entry, `libraries[${i}]`);
    const id = str(lib.id, `libraries[${i}].id`);
    if (!ID_RE.test(id)) {
      throw new ConfigError(`libraries[${i}].id "${id}" must be lowercase letters, digits, "-" or "_"`);
    }
    if (seen.has(id)) throw new ConfigError(`duplicate library id "${id}"`);
    seen.add(id);
    return {
      id,
      name: str(lib.name, `libraries[${i}].name`, id),
      path: resolvePath(str(lib.path, `libraries[${i}].path`)),
      recursive: bool(lib.recursive, `libraries[${i}].recursive`, true),
      writable: bool(lib.writable, `libraries[${i}].writable`, false),
      showInAll: bool(lib.showInAll, `libraries[${i}].showInAll`, true),
    };
  });

  const allowedHosts = server.allowedHosts ?? [];
  if (!Array.isArray(allowedHosts) || allowedHosts.some((h) => typeof h !== 'string')) {
    throw new ConfigError('server.allowedHosts must be a list of hostnames');
  }

  const comfyui = str(generate.comfyui, 'generate.comfyui', 'http://127.0.0.1:8188').replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+$/.test(comfyui)) throw new ConfigError('generate.comfyui must be an http(s) URL like http://127.0.0.1:8188');
  let outputLibrary: string | null = null;
  if (generate.outputLibrary !== undefined && generate.outputLibrary !== null) {
    outputLibrary = str(generate.outputLibrary, 'generate.outputLibrary');
    if (!seen.has(outputLibrary)) throw new ConfigError(`generate.outputLibrary "${outputLibrary}" is not a library id`);
  } else if (seen.has('comfyui')) {
    outputLibrary = 'comfyui';
  }

  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const xdgData = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  const xdgCache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');

  return {
    server: {
      host: str(server.host, 'server.host', '127.0.0.1'),
      port: num(server.port, 'server.port', 2334, 1, 65535),
      allowedHosts: (allowedHosts as string[]).map((h) => h.toLowerCase()),
    },
    dataDir: resolvePath(str(root.dataDir, 'dataDir', path.join(xdgData, 'wandering-gallery'))),
    cacheDir: resolvePath(str(root.cacheDir, 'cacheDir', path.join(xdgCache, 'wandering-gallery'))),
    libraries,
    scan: {
      stableSeconds: num(scan.stableSeconds, 'scan.stableSeconds', 5, 0, 3600),
      intervalMinutes: num(scan.intervalMinutes, 'scan.intervalMinutes', 60, 0, 10080),
      usePolling: bool(scan.usePolling, 'scan.usePolling', false),
    },
    trash: {
      retentionDays: num(trash.retentionDays, 'trash.retentionDays', 7, 0, 3650),
    },
    datasets: {
      root: resolvePath(str(datasets.root, 'datasets.root', path.join(os.homedir(), 'Datasets'))),
      subfolder,
    },
    thumbnails: {
      size: num(thumbs.size, 'thumbnails.size', 360, 64, 1024),
      quality: num(thumbs.quality, 'thumbnails.quality', 78, 30, 100),
    },
    tools: {
      ffmpeg: str(tools.ffmpeg, 'tools.ffmpeg', 'ffmpeg'),
      ffprobe: str(tools.ffprobe, 'tools.ffprobe', 'ffprobe'),
    },
    generate: {
      comfyui,
      comfyCli: str(generate.comfyCli, 'generate.comfyCli', 'comfy-cli'),
      outputLibrary,
      workflowsDir: resolvePath(str(generate.workflowsDir, 'generate.workflowsDir', REPO_WORKFLOWS)),
      promptsDir: resolvePath(str(generate.promptsDir, 'generate.promptsDir', path.join(xdgConfig, 'wandering-gallery', 'prompts'))),
    },
  };
}

export function loadConfig(file = defaultConfigPath()): AppConfig {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new ConfigError(`cannot read config file ${file}: ${(err as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (err) {
    throw new ConfigError(`invalid YAML in ${file}: ${(err as Error).message}`);
  }
  const cfg = parseConfig(raw, path.dirname(path.resolve(file)));
  const overlapping = findOverlap(cfg);
  if (overlapping) throw new ConfigError(overlapping);
  return cfg;
}

/** Trash/cache directories inside a library would be scanned as media; reject that. */
function findOverlap(cfg: AppConfig): string | null {
  for (const lib of cfg.libraries) {
    for (const [label, dir] of [['dataDir', cfg.dataDir], ['cacheDir', cfg.cacheDir]] as const) {
      const rel = path.relative(lib.path, dir);
      if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
        return `${label} (${dir}) must not be inside library "${lib.id}" (${lib.path})`;
      }
    }
  }
  return null;
}
