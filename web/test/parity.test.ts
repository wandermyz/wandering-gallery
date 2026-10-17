import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkParity, parseParity } from '../scripts/parity.js';
import { tmpDir } from './helpers.js';

const ROOT = path.resolve(import.meta.dirname, '../..');

describe('web ↔ iOS parity (docs/parity.md)', () => {
  it('matches the tests on both sides', () => {
    expect(checkParity(ROOT).errors).toEqual([]);
  });

  it('reports untagged ✅, stale statuses, unknown IDs and pending without a reason', () => {
    const root = tmpDir();
    fs.mkdirSync(path.join(root, 'docs'));
    fs.mkdirSync(path.join(root, 'web/e2e'), { recursive: true });
    fs.mkdirSync(path.join(root, 'ios/WanderingGalleryUITests'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs/parity.md'), [
      '| ID | Behavior | Web | iOS | Notes |', '| --- | --- | --- | --- | --- |',
      '| A-01 | one | ✅ | ✅ | |', '| A-02 | two | untested | pending | |', '| A-03 | three | ✅ | n/a | |',
    ].join('\n'));
    fs.writeFileSync(path.join(root, 'web/e2e/a.spec.ts'), '// parity: A-01, A-02\ntest()\n// parity: Z-09\ntest()');
    fs.writeFileSync(path.join(root, 'ios/WanderingGalleryUITests/A.swift'), '/// parity: A-01\nfunc testA() {}');
    expect(checkParity(root).errors.sort()).toEqual([
      'A-02: a web test carries it (web/e2e/a.spec.ts) but web is "untested"; make it ✅',
      'A-02: iOS is pending, so Notes must say why',
      'A-03: web is ✅ but no web test carries "parity: A-03"',
      'Z-09: tagged in web/e2e/a.spec.ts but not in docs/parity.md',
    ]);
  });

  it('reads only ID rows', () => {
    const { rows } = parseParity('| Status | Meaning | Check |\n| `✅` | Built | x |\n| GAL-01 | Grid | ✅ | untested | n |');
    expect(rows).toEqual([{ id: 'GAL-01', behavior: 'Grid', web: '✅', ios: 'untested', notes: 'n' }]);
  });
});
