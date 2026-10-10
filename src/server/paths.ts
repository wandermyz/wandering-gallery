import fs from 'node:fs';
import path from 'node:path';

/** An error that maps to an HTTP status (path violations, conflicts, ...). */
export class HttpError extends Error {
  /** `data` is merged into the JSON error body (e.g. details the client can act on). */
  constructor(message: string, readonly status = 403, readonly data?: Record<string, unknown>) {
    super(message);
  }
}

export function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

/**
 * Validates a library-relative path from the database or a request. Rejects
 * absolute paths, `..` segments, NUL bytes and backslashes outright rather than
 * normalising them away.
 */
export function checkRelPath(rel: string): string {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\0') || rel.includes('\\')) {
    throw new HttpError('invalid path', 400);
  }
  if (rel.startsWith('/')) throw new HttpError('absolute paths are not allowed', 400);
  const parts = rel.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) throw new HttpError('invalid path', 400);
  return rel;
}

/** Folder paths are like rel paths but may be empty (library root). */
export function checkFolder(folder: string): string {
  if (folder === '') return '';
  return checkRelPath(folder);
}

/**
 * Resolves `rel` inside `libraryRoot`, following symlinks, and verifies the real
 * target is still inside the library's real root. Returns the real path.
 */
export async function resolveInside(libraryRoot: string, rel: string): Promise<string> {
  checkRelPath(rel);
  let realRoot: string;
  try {
    realRoot = await fs.promises.realpath(libraryRoot);
  } catch {
    throw new HttpError('library is unavailable', 404);
  }
  const joined = path.join(realRoot, ...rel.split('/'));
  let real: string;
  try {
    real = await fs.promises.realpath(joined);
  } catch {
    throw new HttpError('file not found', 404);
  }
  if (!isInside(realRoot, real)) throw new HttpError('path escapes library');
  return real;
}

/** Same as resolveInside, but for a path that may not exist yet (restore target). */
export async function resolveTargetInside(libraryRoot: string, rel: string): Promise<string> {
  checkRelPath(rel);
  const realRoot = await fs.promises.realpath(libraryRoot).catch(() => {
    throw new HttpError('library is unavailable', 404);
  });
  const target = path.join(realRoot, ...rel.split('/'));
  // Walk up to the nearest existing ancestor and make sure it resolves inside.
  let probe = path.dirname(target);
  for (;;) {
    try {
      const real = await fs.promises.realpath(probe);
      if (!isInside(realRoot, real)) throw new HttpError('path escapes library');
      break;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      const parent = path.dirname(probe);
      if (parent === probe) throw new HttpError('path escapes library');
      probe = parent;
    }
  }
  return target;
}

export function toPosix(rel: string): string {
  return rel.split(path.sep).join('/');
}
