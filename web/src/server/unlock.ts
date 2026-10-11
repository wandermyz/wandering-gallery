import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { HttpError } from './paths.js';

const scrypt = promisify(crypto.scrypt) as (pw: crypto.BinaryLike, salt: crypto.BinaryLike, len: number, opts: crypto.ScryptOptions) => Promise<Buffer>;

const COOKIE = 'wg_unlock';
const HASH_RE = /^scrypt:(\d+):(\d+):(\d+):([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+)$/;
/** Failed attempts allowed before each further one has to wait (doubling, up to an hour). */
const FREE_ATTEMPTS = 5;
const MAX_WAIT_MS = 3600_000;

/** `scrypt:N:r:p:salt:hash`, the format of `hidden.passphraseHash` in the config. */
export async function hashPassphrase(passphrase: string): Promise<string> {
  const N = 1 << 15, r = 8, p = 1;
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(passphrase.normalize('NFC'), salt, 32, { N, r, p, maxmem: 256 * N * r });
  return `scrypt:${N}:${r}:${p}:${salt.toString('base64')}:${hash.toString('base64')}`;
}

export function isPassphraseHash(s: string): boolean {
  return HASH_RE.test(s);
}

async function verifyPassphrase(passphrase: string, stored: string): Promise<boolean> {
  const m = HASH_RE.exec(stored);
  if (!m) return false;
  const [N, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const expected = Buffer.from(m[5], 'base64');
  const hash = await scrypt(passphrase.normalize('NFC'), Buffer.from(m[4], 'base64'), expected.length, { N, r, p, maxmem: 256 * N * r });
  return crypto.timingSafeEqual(hash, expected);
}

function readCookie(req: FastifyRequest, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * Unlocking hidden assets. A correct passphrase earns the browser a signed cookie
 * `<expiry>.<hmac>` that is valid for a fixed time. The signing key lives only in
 * memory, so restarting the server locks every browser again.
 */
export class Unlock {
  private readonly key = crypto.randomBytes(32);
  private failures = 0;
  private lastFailureMs = 0;

  constructor(private readonly passphraseHash: string | null, private readonly durationMs: number) {}

  get enabled(): boolean {
    return this.passphraseHash !== null;
  }

  private sign(exp: number): string {
    return crypto.createHmac('sha256', this.key).update(String(exp)).digest('base64url');
  }

  /** Expiry (epoch ms) of this request's unlock, or null when it is locked. */
  until(req: FastifyRequest): number | null {
    const v = readCookie(req, COOKIE);
    const m = v ? /^(\d{1,15})\.([\w-]{43})$/.exec(v) : null;
    if (!m) return null;
    const exp = Number(m[1]);
    const sig = Buffer.from(m[2]);
    const good = Buffer.from(this.sign(exp));
    if (sig.length !== good.length || !crypto.timingSafeEqual(sig, good)) return null;
    return exp > Date.now() ? exp : null;
  }

  isUnlocked(req: FastifyRequest): boolean {
    return this.until(req) !== null;
  }

  /** Checks the passphrase and sets the unlock cookie; returns the expiry. */
  async unlock(req: FastifyRequest, reply: FastifyReply, passphrase: unknown): Promise<number> {
    if (!this.passphraseHash) throw new HttpError('Hidden items are not set up: add hidden.passphraseHash to the config', 409);
    if (typeof passphrase !== 'string' || !passphrase || passphrase.length > 1024) throw new HttpError('passphrase is required', 400);
    const wait = this.failures >= FREE_ATTEMPTS
      ? this.lastFailureMs + Math.min(30_000 * 2 ** (this.failures - FREE_ATTEMPTS), MAX_WAIT_MS) - Date.now()
      : 0;
    if (wait > 0) {
      reply.header('Retry-After', String(Math.ceil(wait / 1000)));
      throw new HttpError(`Too many wrong passphrases. Try again in ${Math.ceil(wait / 1000)} s.`, 429);
    }
    if (!(await verifyPassphrase(passphrase, this.passphraseHash))) {
      this.failures++;
      this.lastFailureMs = Date.now();
      throw new HttpError('Wrong passphrase', 403);
    }
    this.failures = 0;
    const exp = Date.now() + this.durationMs;
    this.setCookie(req, reply, `${exp}.${this.sign(exp)}`, Math.floor(this.durationMs / 1000));
    return exp;
  }

  lock(req: FastifyRequest, reply: FastifyReply) {
    this.setCookie(req, reply, '', 0);
  }

  private setCookie(req: FastifyRequest, reply: FastifyReply, value: string, maxAge: number) {
    const secure = req.protocol === 'https' ? '; Secure' : '';
    reply.header('Set-Cookie', `${COOKIE}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Strict${secure}`);
  }
}
