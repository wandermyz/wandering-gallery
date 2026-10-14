#!/usr/bin/env node
// Stand-in for gpu-workload in the browser tests: `switch comfy` always succeeds and
// `status` reports ComfyUI holding the GPU.
if (process.argv[2] === 'status') {
  process.stdout.write(JSON.stringify({
    mode: 'comfy',
    strata: { service: true, reachable: true, loaded: false },
    comfy: { service: true, reachable: true, running: 0, pending: 0, holds_models: true },
    gpu: { total_mib: 16303, free_mib: 4000, strata_mib: 0, comfy_mib: 11800, other_mib: 503 },
    last_event: { time: '2026-10-13T17:25:15-07:00', event: 'switch', to: 'comfy', ok: true, previous: 'strata' },
  }) + '\n');
} else {
  process.stdout.write(JSON.stringify({ mode: 'comfy', ok: true }) + '\n');
}
