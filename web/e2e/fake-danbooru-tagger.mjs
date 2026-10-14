#!/usr/bin/env node
// Stand-in for danbooru-tagger in the browser tests.
// `tag --json ... -- <description>`: echoes the description's first line so tests can
// tell variations apart.
// `search --json -k K -- <queries…>`: K hits per query; "red eyes" is a known tag, the
// rest are not.
const args = process.argv.slice(2);
if (args[0] === 'search') {
  const k = Number(args[args.indexOf('-k') + 1]);
  const queries = args.slice(args.indexOf('--') + 1);
  const hits = (q) => {
    const base = q.replace(/ /g, '_');
    const names = q === 'red eyes' ? ['red_eyes', 'red_eyeliner', 'red_eyeshadow', 'pink_eyes', 'red_eyes_(e.g.o)', 'orange_eyes']
      : Array.from({ length: k }, (_, i) => `${base}_(variant_${i + 1})`);
    return names.slice(0, k).map((tag, i) => ({ tag, category: 'general', posts: 1000 - i, score: 1 - i / 10 }));
  };
  process.stdout.write(JSON.stringify(Object.fromEntries(queries.map((q) => [q, hits(q)]))) + '\n');
  process.exit(0);
}
const description = args[args.indexOf('--') + 1] ?? '';
const vary = description.includes('\n\n');
await new Promise((r) => setTimeout(r, 300));
process.stdout.write(JSON.stringify({ ok: true, positive: `1girl, ${vary ? 'varied' : 'base'} tags for ${description.split('\n')[0]}` }) + '\n');
