#!/usr/bin/env node
// Stand-in for comfy-cli in the browser tests: the subcommands and JSON envelopes the
// server uses (system-stats, jobs status|watch|cancel), backed by
// fake-comfy.mjs at $COMFY_LOCAL_URL.

const base = process.env.COMFY_LOCAL_URL;
const args = process.argv.slice(2).filter((a) => a !== '--json' && a !== '--json-stream');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const ok = (command, data) => out({ schema: 'envelope/1', type: 'envelope', ok: true, command, data, error: null });
const fail = (command, code, message, details) => out({ schema: 'envelope/1', type: 'envelope', ok: false, command, data: null, error: { code, message, details } });

async function get(p, init) {
  try {
    const r = await fetch(base + p, init);
    if (r.status === 503) return null;
    return await r.json();
  } catch {
    return null;
  }
}
const down = (command) => fail(command, 'server_not_running', `ComfyUI not running on ${base}`);

const [cmd, sub, id] = args;
if (cmd === 'system-stats') {
  const s = await get('/system_stats');
  s ? ok('system-stats', s) : down('system-stats');
} else if (cmd === 'jobs' && (sub === 'status' || sub === 'watch')) {
  for (;;) {
    const j = await get(`/fake/jobs/${id}`);
    if (!j) {
      down('jobs');
      break;
    }
    if (sub === 'watch' && j.status === 'running') out({ schema: 'event/1', type: 'progress', node: '5', completed: Math.round(j.progress * 28), total: 28, prompt_id: id });
    const terminal = ['completed', 'error', 'cancelled'].includes(j.status);
    if (terminal || sub === 'status') {
      const data = { prompt_id: id, status: j.status, outputs: j.outputs };
      j.status === 'completed' || !terminal ? ok(`jobs ${sub}`, data) : fail('jobs', j.status === 'cancelled' ? 'cancelled' : 'execution_error', `job ${j.status}`, data);
      break;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
} else if (cmd === 'jobs' && sub === 'cancel') {
  (await get(`/fake/jobs/${id}`, { method: 'DELETE' })) ? ok('jobs cancel', { prompt_id: id, found: true }) : down('jobs');
} else {
  fail(cmd ?? '', 'usage', `fake comfy-cli: unsupported ${args.join(' ')}`);
  process.exit(2);
}
