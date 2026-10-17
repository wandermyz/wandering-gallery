#!/usr/bin/env node
// Stand-in for vhotseat in the browser tests: `switch comfy` always succeeds and
// `status` reports ComfyUI holding the GPU, or nothing holding it while
// .tmp/fake-vhotseat-mode says "none" (tests write it).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const modeFile = fileURLToPath(new URL('../.tmp/fake-vhotseat-mode', import.meta.url));
let mode = 'comfy';
try {
  mode = readFileSync(modeFile, 'utf8').trim() || mode;
} catch {
  /* no file: ComfyUI holds it */
}

if (process.argv[2] === 'status') {
  const free = mode === 'none';
  process.stdout.write(JSON.stringify({
    mode,
    strata: { service: true, reachable: true, loaded: false },
    comfy: { service: true, reachable: true, running: 0, pending: 0, holds_models: !free },
    gpu: { total_mib: 16303, free_mib: free ? 15800 : 4000, strata_mib: 0, comfy_mib: free ? 0 : 11800, other_mib: 503 },
    last_event: { time: '2026-10-13T17:25:15-07:00', event: 'switch', to: mode, ok: true, previous: 'strata' },
  }) + '\n');
} else {
  process.stdout.write(JSON.stringify({ mode: 'comfy', ok: true }) + '\n');
}
