import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseConfig } from '../src/server/config.js';
import { tmpDir } from './helpers.js';

describe('config', () => {
  it('loads a YAML file with multiple libraries and applies defaults', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'config.yaml');
    fs.writeFileSync(file, `
libraries:
  - id: comfyui
    name: ComfyUI Outputs
    path: ./out
    recursive: true
    writable: true
  - id: inputs
    name: Inputs
    path: /srv/inputs
    recursive: false
`);
    const cfg = loadConfig(file);
    expect(cfg.libraries).toHaveLength(2);
    expect(cfg.libraries[0]).toEqual({ id: 'comfyui', name: 'ComfyUI Outputs', path: path.join(dir, 'out'), recursive: true, writable: true, showInAll: true, hidden: false });
    // Libraries are read-only unless explicitly writable.
    expect(cfg.libraries[1]).toMatchObject({ id: 'inputs', path: '/srv/inputs', recursive: false, writable: false });
    expect(cfg.server).toEqual({ host: '127.0.0.1', port: 2334, allowedHosts: [] });
    expect(cfg.trash.retentionDays).toBe(7);
    expect(cfg.scan.stableSeconds).toBe(5);
  });

  it('expands ~ in paths', () => {
    const cfg = parseConfig({ libraries: [{ id: 'a', path: '~/pics' }] });
    expect(cfg.libraries[0].path).toBe(path.join(process.env.HOME!, 'pics'));
  });

  it.each([
    [{}, /libraries must be a non-empty list/],
    [{ libraries: [] }, /non-empty list/],
    [{ libraries: [{ id: 'a' }] }, /path is required/],
    [{ libraries: [{ id: 'Bad Id', path: '/x' }] }, /must be lowercase/],
    [{ libraries: [{ id: 'a', path: '/x' }, { id: 'a', path: '/y' }] }, /duplicate library id/],
    [{ libraries: [{ id: 'a', path: '/x', writable: 'yes' }] }, /writable must be true or false/],
    [{ libraries: [{ id: 'a', path: '/x', showInAll: 'no' }] }, /showInAll must be true or false/],
    [{ libraries: [{ id: 'a', path: '/x' }], server: { port: 99999 } }, /server.port/],
    [{ libraries: [{ id: 'a', path: '/x' }], trash: { retentionDays: -1 } }, /retentionDays/],
  ])('rejects invalid config %#', (raw, msg) => {
    expect(() => parseConfig(raw)).toThrow(ConfigError);
    expect(() => parseConfig(raw)).toThrow(msg);
  });

  it('reports missing files and bad YAML clearly', () => {
    const dir = tmpDir();
    expect(() => loadConfig(path.join(dir, 'nope.yaml'))).toThrow(/cannot read config file/);
    const bad = path.join(dir, 'bad.yaml');
    fs.writeFileSync(bad, 'libraries: [\n');
    expect(() => loadConfig(bad)).toThrow(/invalid YAML/);
  });

  it('refuses data or cache directories inside a library', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'c.yaml');
    fs.writeFileSync(file, `dataDir: ./lib/.gallery\nlibraries:\n  - { id: a, path: ./lib }\n`);
    expect(() => loadConfig(file)).toThrow(/must not be inside library/);
  });
});
