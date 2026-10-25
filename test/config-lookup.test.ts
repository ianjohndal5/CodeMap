import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { analyze } from '../src/analyze.js';
import { defaultConfig, findConfig, loadConfig } from '../src/config.js';
import type { ConfigStart } from '../src/config.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seammap-config-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Create files (path -> content) under a fresh folder; a value of null makes a directory. */
function tree(name: string, files: Record<string, string | null>): string {
  const root = path.join(tmp, name);
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    if (content === null) fs.mkdirSync(p, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    }
  }
  return root;
}
const projects = (root: string): ConfigStart[] => [
  { dir: path.join(root, 'api'), label: 'backend root', role: 'backend' },
  { dir: path.join(root, 'web'), label: 'frontend root', role: 'frontend' },
];
/** Whether the temp folder itself sits in a git repository (then searches would continue above it). */
const tmpInGit = (() => {
  for (let d = tmp; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return true;
    if (path.dirname(d) === d) return false;
  }
})();

describe('findConfig', () => {
  it('finds the config at the repository root, wherever the command runs', () => {
    const root = tree('repo', { '.git': null, 'api/x': '', 'web/x': '', 'seammap.config.json': '{}' });
    const found = findConfig(projects(root));
    expect(found.file).toBe(path.join(root, 'seammap.config.json'));
    expect(found.how).toBe('1 folder above the backend root');
    expect(found.searched).toEqual([path.join(root, 'api'), root, path.join(root, 'web')]);
  });

  it('does not look above the repository root', () => {
    const root = tree('nested', { 'seammap.config.json': '{}', 'repo/.git': null, 'repo/api/x': '', 'repo/web/x': '' });
    const found = findConfig(projects(path.join(root, 'repo')));
    expect(found.file).toBeNull();
    expect(found.how).toBe('none found');
    expect(found.searched).not.toContain(root);
  });

  it('prefers the closest file, and lists the others', () => {
    const root = tree('closest', { '.git': null, 'api/x': '', 'web/seammap.config.json': '{}', 'seammap.config.json': '{}' });
    const found = findConfig(projects(root));
    expect(found.file).toBe(path.join(root, 'web', 'seammap.config.json'));
    expect(found.how).toBe('in the frontend root; the closest');
    expect(found.others).toEqual([path.join(root, 'seammap.config.json')]);
  });

  it('prefers a config that names the analyzed projects over a closer or earlier one', () => {
    // Like legacy/ and homes/ side by side: each folder's config was written for a different pair.
    const root = tree('named', {
      '.git': null,
      'one/api/x': '',
      'one/seammap.config.json': '{ "backend": "api", "frontend": "other-web" }',
      'two/web/x': '',
      'two/seammap.config.json': '// for this pair\n{ "backend": "../one/api", "frontend": "web" }',
    });
    const found = findConfig([
      { dir: path.join(root, 'one', 'api'), label: 'backend root', role: 'backend' },
      { dir: path.join(root, 'two', 'web'), label: 'frontend root', role: 'frontend' },
    ]);
    expect(found.file).toBe(path.join(root, 'two', 'seammap.config.json'));
    expect(found.how).toBe('1 folder above the frontend root; it names these projects');
  });

  it('breaks a tie in favour of the backend', () => {
    const root = tree('tie', { '.git': null, 'api/seammap.config.json': '{}', 'web/seammap.config.json': '{}' });
    const found = findConfig(projects(root));
    expect(found.file).toBe(path.join(root, 'api', 'seammap.config.json'));
    expect(found.how).toBe('in the backend root; as close as another, and the backend comes first');
  });

  it.runIf(!tmpInGit)('outside a repository, looks up to the folder holding both projects and no further', () => {
    const root = tree('plain', { 'seammap.config.json': '{}', 'work/api/x': '', 'work/web/x': '' });
    expect(findConfig(projects(path.join(root, 'work'))).file).toBeNull();
    fs.writeFileSync(path.join(root, 'work', 'seammap.config.json'), '{}');
    const found = findConfig(projects(path.join(root, 'work')));
    expect(found.file).toBe(path.join(root, 'work', 'seammap.config.json'));
    // With one project outside a repository, only its own folder counts.
    expect(findConfig([{ dir: path.join(root, 'work', 'web'), label: 'frontend root', role: 'frontend' }]).file).toBeNull();
  });
});

describe('the config recorded in graph.json', () => {
  const fixtures = path.resolve(__dirname, '..', 'fixtures');
  const settings = '{\n  "next": { "backendHosts": ["api.example.com"] },\n  "laravel": { "apiPrefix": "/api" }\n}\n';

  it('hashes the settings, not the bytes', () => {
    const dir = tree('hash', {
      'plain.json': settings,
      // A Windows checkout: byte-order mark, \r\n, plus comments and another key order.
      'windows.json': '﻿// same settings\r\n{\r\n  "laravel": { "apiPrefix": "/api" },\r\n  "next": { "backendHosts": ["api.example.com"], },\r\n}\r\n',
      'other.json': settings.replace('/api', '/v2'),
    });
    const hash = (f: string) => loadConfig(path.join(dir, f), dir).config.source?.sha256;
    expect(hash('plain.json')).toMatch(/^[0-9a-f]{64}$/);
    expect(hash('windows.json')).toBe(hash('plain.json'));
    expect(hash('other.json')).not.toBe(hash('plain.json'));
  });

  it('is relative to the backend root, or null without a config file', () => {
    const dir = tree('record', { 'seammap.config.json': settings });
    const backend = path.join(fixtures, 'laravel-api');
    const { config } = loadConfig(path.join(dir, 'seammap.config.json'), dir);
    const graph = analyze({ backend, frontend: null, config }).graph;
    expect(graph.meta.config).toEqual({ path: path.relative(backend, path.join(dir, 'seammap.config.json')).split(path.sep).join('/'), sha256: config.source!.sha256 });
    expect(analyze({ backend, frontend: null, config: defaultConfig() }).graph.meta.config).toBeNull();
  });
});
