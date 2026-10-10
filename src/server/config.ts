import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

export interface LibraryConfig {
  id: string;
  name: string;
  path: string;
  recursive: boolean;
  writable: boolean;
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
  thumbnails: {
    size: number;
    quality: number;
  };
  tools: {
    ffmpeg: string;
    ffprobe: string;
  };
}

export class ConfigError extends Error {}

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
    };
  });

  const allowedHosts = server.allowedHosts ?? [];
  if (!Array.isArray(allowedHosts) || allowedHosts.some((h) => typeof h !== 'string')) {
    throw new ConfigError('server.allowedHosts must be a list of hostnames');
  }

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
    thumbnails: {
      size: num(thumbs.size, 'thumbnails.size', 360, 64, 1024),
      quality: num(thumbs.quality, 'thumbnails.quality', 78, 30, 100),
    },
    tools: {
      ffmpeg: str(tools.ffmpeg, 'tools.ffmpeg', 'ffmpeg'),
      ffprobe: str(tools.ffprobe, 'tools.ffprobe', 'ffprobe'),
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
