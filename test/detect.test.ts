import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { findProjects, readTsPaths, resolveRoots } from '../src/detect.js';
import { parseJsonc } from '../src/util/jsonc.js';

const fixtures = path.resolve(__dirname, '..', 'fixtures');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-test-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('project detection', () => {
  it('finds both projects under a monorepo root', () => {
    expect(findProjects(fixtures)).toEqual({ laravel: [path.join(fixtures, 'laravel-api')], next: [path.join(fixtures, 'next-web')] });
    const roots = resolveRoots({ root: fixtures });
    expect(roots.backend).toBe(path.join(fixtures, 'laravel-api'));
    expect(roots.frontend).toBe(path.join(fixtures, 'next-web'));
  });

  it('asks for explicit flags when detection is ambiguous or empty', () => {
    const mono = path.join(tmp, 'mono');
    for (const d of ['api-a', 'api-b']) {
      fs.mkdirSync(path.join(mono, d), { recursive: true });
      fs.writeFileSync(path.join(mono, d, 'composer.json'), '{}');
      fs.writeFileSync(path.join(mono, d, 'artisan'), '');
    }
    expect(() => resolveRoots({ root: mono })).toThrow(/several Laravel projects.*--backend/s);
    const empty = path.join(tmp, 'empty');
    fs.mkdirSync(empty);
    expect(() => resolveRoots({ root: empty })).toThrow(/--backend <laravelPath> --frontend <nextPath>/);
    expect(() => resolveRoots({ backend: path.join(tmp, 'nope') })).toThrow(/does not exist/);
  });

  it('reads tsconfig paths (JSONC) and warns when there is none', () => {
    const warnings: string[] = [];
    expect(readTsPaths(path.join(fixtures, 'next-web'), warnings)).toEqual({
      baseDir: '',
      hasBaseUrl: false,
      paths: [{ pattern: '@/*', targets: ['./src/*'] }],
    });
    expect(warnings).toEqual([]);
    readTsPaths(tmp, warnings);
    expect(warnings[0]).toMatch(/No tsconfig.json/);
  });
});

describe('config and JSONC', () => {
  it('parses comments and trailing commas without touching strings', () => {
    expect(parseJsonc('{ // c\n "a": "x,}//y", /* b */ "b": [1,2,], }')).toEqual({ a: 'x,}//y', b: [1, 2] });
  });

  it('loads codemap.config.json relative to its directory', () => {
    const dir = path.join(tmp, 'cfg');
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, 'codemap.config.json'),
      JSON.stringify({ backend: '../api', laravel: { apiPrefix: '/api/v2', exclude: ['app/Legacy/**'] }, next: { backendEnvVars: ['NEXT_PUBLIC_API_URL'] } }),
    );
    const { config, file } = loadConfig(undefined, dir);
    expect(file).toBe(path.join(dir, 'codemap.config.json'));
    expect(config.backend).toBe(path.join(tmp, 'api'));
    expect(config.laravel).toMatchObject({ apiPrefix: '/api/v2', exclude: ['app/Legacy/**'] });
    expect(config.next.backendEnvVars).toEqual(['NEXT_PUBLIC_API_URL']);
    expect(() => loadConfig('missing.json', dir)).toThrow(/not found/);
  });
});
