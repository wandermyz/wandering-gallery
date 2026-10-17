// Checks docs/parity.md (web ↔ iOS feature parity) against the tests' `// parity: ID` tags.
//   npm run parity     # summary, including what iOS or web still has pending
// `npm test` runs the same check (test/parity.test.ts).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Status = '✅' | 'untested' | 'pending' | 'n/a';
export interface Row { id: string; behavior: string; web: Status; ios: Status; notes: string }
export interface ParityReport { rows: Row[]; errors: string[] }

const STATUSES: Status[] = ['✅', 'untested', 'pending', 'n/a'];
const TAG = /parity:\s*([A-Z]+-\d+(?:\s*,\s*[A-Z]+-\d+)*)/g;

/** Test files per side, relative to the repo root. */
const SOURCES = {
  web: [{ dir: 'web/e2e', ext: '.spec.ts' }],
  ios: [{ dir: 'ios/WanderingGalleryUITests', ext: '.swift' }, { dir: 'ios/WanderingGalleryTests', ext: '.swift' }],
};

export function parseParity(markdown: string): { rows: Row[]; errors: string[] } {
  const rows: Row[] = [];
  const errors: string[] = [];
  for (const line of markdown.split('\n')) {
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length !== 5 || !/^[A-Z]+-\d+$/.test(cells[0])) continue;
    const [id, behavior, web, ios, notes] = cells;
    for (const [side, s] of [['web', web], ['iOS', ios]] as const) {
      if (!STATUSES.includes(s as Status)) errors.push(`${id}: ${side} status "${s}" is not one of ${STATUSES.join(', ')}`);
      if (s === 'pending' && !notes) errors.push(`${id}: ${side} is pending, so Notes must say why`);
    }
    if (rows.some((r) => r.id === id)) errors.push(`${id}: listed twice`);
    rows.push({ id, behavior, web: web as Status, ios: ios as Status, notes });
  }
  return { rows, errors };
}

/** ID → files whose tests carry it. */
export function findTags(root: string, side: keyof typeof SOURCES): Map<string, string[]> {
  const tags = new Map<string, string[]>();
  for (const { dir, ext } of SOURCES[side]) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs).filter((f) => f.endsWith(ext))) {
      const text = fs.readFileSync(path.join(abs, f), 'utf8');
      for (const m of text.matchAll(TAG)) {
        for (const id of m[1].split(',').map((s) => s.trim())) tags.set(id, [...(tags.get(id) ?? []), `${dir}/${f}`]);
      }
    }
  }
  return tags;
}

export function checkParity(root: string): ParityReport {
  const { rows, errors } = parseParity(fs.readFileSync(path.join(root, 'docs/parity.md'), 'utf8'));
  const ids = new Set(rows.map((r) => r.id));
  for (const side of ['web', 'ios'] as const) {
    const label = side === 'web' ? 'web' : 'iOS';
    const tags = findTags(root, side);
    for (const [id, files] of tags) {
      if (!ids.has(id)) errors.push(`${id}: tagged in ${files.join(', ')} but not in docs/parity.md`);
    }
    for (const r of rows) {
      const tested = tags.has(r.id);
      if (r[side] === '✅' && !tested) errors.push(`${r.id}: ${label} is ✅ but no ${label} test carries "parity: ${r.id}"`);
      if (r[side] !== '✅' && tested) errors.push(`${r.id}: a ${label} test carries it (${tags.get(r.id)!.join(', ')}) but ${label} is "${r[side]}"; make it ✅`);
    }
  }
  return { rows, errors };
}

// Run directly (`npm run parity`), on any OS.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(import.meta.dirname, '../..');
  const { rows, errors } = checkParity(root);
  const count = (side: 'web' | 'ios', s: Status) => rows.filter((r) => r[side] === s).length;
  console.log(`${rows.length} behaviors · web: ${count('web', '✅')} tested, ${count('web', 'untested')} untested, ${count('web', 'pending')} pending · ` +
    `iOS: ${count('ios', '✅')} tested, ${count('ios', 'untested')} untested, ${count('ios', 'pending')} pending`);
  for (const side of ['web', 'ios'] as const) {
    for (const r of rows.filter((x) => x[side] === 'pending')) console.log(`  pending on ${side === 'web' ? 'web' : 'iOS'}: ${r.id} ${r.behavior} (${r.notes})`);
  }
  for (const e of errors) console.error(`  error: ${e}`);
  process.exit(errors.length ? 1 : 0);
}
