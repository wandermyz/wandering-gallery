import { spawn } from 'node:child_process';

export interface RunResult {
  stdout: Buffer;
  stderr: string;
}

/**
 * Runs a tool with an argument vector (never through a shell), with a timeout
 * and an output cap. File paths are always absolute, so a filename beginning
 * with "-" cannot be mistaken for an option.
 */
export function run(cmd: string, args: string[], opts: { timeoutMs?: number; maxBytes?: number } = {}): Promise<RunResult> {
  const { timeoutMs = 60_000, maxBytes = 64 * 1024 * 1024 } = opts;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let outLen = 0;
    let err = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      outLen += d.length;
      if (outLen > maxBytes) {
        killed = true;
        child.kill('SIGKILL');
        return;
      }
      out.push(d);
    });
    child.stderr.on('data', (d: Buffer) => {
      if (err.length < 4096) err += d.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return reject(new Error(`${cmd} timed out or produced too much output`));
      if (code !== 0) return reject(new Error(`${cmd} exited with ${code}: ${err.trim().split('\n').pop() ?? ''}`));
      resolve({ stdout: Buffer.concat(out), stderr: err });
    });
  });
}
