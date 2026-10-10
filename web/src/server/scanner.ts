import fs from 'node:fs';
import path from 'node:path';
import type { LibraryConfig } from './config.js';
import { isIgnoredName, mediaType, sidecarStem } from './media.js';
import { isInside } from './paths.js';

export interface FileEntry {
  rel: string;
  abs: string;
  size: number;
  mtimeMs: number;
  ino: number;
  /** Creation time (statx btime); 0 where the filesystem does not report it. */
  birthMs: number;
}

export interface WalkResult {
  files: FileEntry[];
  /** Possible caption sidecars (`*.txt`, `*.caption.json`); matched to media files by the indexer. */
  sidecars: FileEntry[];
  /** Folders (library-relative) that could not be read; their DB rows must be left untouched. */
  failedDirs: string[];
}

/**
 * Lists media files in a library. Symlinked files are followed only when the
 * target resolves inside the library; symlinked directories are never followed
 * (prevents loops and escapes). Yields to the event loop between directories.
 */
export async function walkLibrary(lib: LibraryConfig, realRoot: string): Promise<WalkResult> {
  const files: FileEntry[] = [];
  const sidecars: FileEntry[] = [];
  const failedDirs: string[] = [];
  const stack: string[] = [''];
  while (stack.length) {
    const relDir = stack.pop()!;
    const absDir = relDir ? path.join(realRoot, relDir) : realRoot;
    let dir: fs.Dir;
    try {
      dir = await fs.promises.opendir(absDir, { bufferSize: 256 });
    } catch {
      failedDirs.push(relDir);
      continue;
    }
    try {
      for await (const ent of dir) {
        if (isIgnoredName(ent.name)) continue;
        const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
        if (ent.isDirectory()) {
          if (lib.recursive) stack.push(rel);
          continue;
        }
        if (!ent.isFile() && !ent.isSymbolicLink()) continue;
        const isMedia = !!mediaType(ent.name);
        if (!isMedia && !sidecarStem(ent.name)) continue;
        const entry = await statEntry(realRoot, rel);
        if (entry) (isMedia ? files : sidecars).push(entry);
      }
    } catch {
      failedDirs.push(relDir);
    }
    await new Promise((r) => setImmediate(r));
  }
  return { files, sidecars, failedDirs };
}

/** Stats a single library-relative path; returns null if it is not a regular file inside the library. */
export async function statEntry(realRoot: string, rel: string): Promise<FileEntry | null> {
  const abs = path.join(realRoot, ...rel.split('/'));
  try {
    const lst = await fs.promises.lstat(abs);
    let st = lst;
    if (lst.isSymbolicLink()) {
      const target = await fs.promises.realpath(abs);
      if (!isInside(realRoot, target)) return null;
      st = await fs.promises.stat(target);
    }
    if (!st.isFile()) return null;
    return { rel, abs, size: st.size, mtimeMs: Math.floor(st.mtimeMs), ino: st.ino, birthMs: Math.floor(st.birthtimeMs) };
  } catch {
    return null;
  }
}

export function folderOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i < 0 ? '' : rel.slice(0, i);
}
