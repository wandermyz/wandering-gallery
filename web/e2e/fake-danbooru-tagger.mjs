#!/usr/bin/env node
// Stand-in for danbooru-tagger in the browser tests: `tag --json ... -- <description>`.
// Echoes the description's first line so tests can tell variations apart.
const args = process.argv.slice(2);
const description = args[args.indexOf('--') + 1] ?? '';
const vary = description.includes('\n\n');
await new Promise((r) => setTimeout(r, 300));
process.stdout.write(JSON.stringify({ ok: true, positive: `1girl, ${vary ? 'varied' : 'base'} tags for ${description.split('\n')[0]}` }) + '\n');
