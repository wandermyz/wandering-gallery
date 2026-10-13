#!/usr/bin/env node
// Stand-in for gpu-workload in the browser tests: `switch comfy` always succeeds.
process.stdout.write(JSON.stringify({ mode: 'comfy', ok: true }) + '\n');
