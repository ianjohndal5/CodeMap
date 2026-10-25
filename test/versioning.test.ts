import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { changelogVersions } from '../scripts/check-release.mjs';
import { VERSION as CLI_VERSION } from '../src/brand.js';
import { SCHEMA_VERSION, VERSION, analyze, checkSchema } from '../src/index.js';

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string };
const fixtures = path.join(root, 'fixtures');
const graph = analyze({ backend: path.join(fixtures, 'laravel-api'), frontend: path.join(fixtures, 'next-web') }).graph;

describe('versions', () => {
  it("reports package.json's version in the API, the CLI and graph.json", () => {
    expect(VERSION).toBe(pkg.version);
    // What `--version` and the summary print (the installed command is checked in CI: install-matrix.yml).
    expect(CLI_VERSION).toBe(pkg.version);
    expect(graph.meta.version).toBe(pkg.version);
  });

  it('starts graph.json with the schema version', () => {
    expect(Number.isInteger(SCHEMA_VERSION) && SCHEMA_VERSION >= 1).toBe(true);
    const written = JSON.parse(JSON.stringify(graph, null, 1)) as Record<string, unknown>;
    expect(Object.keys(written)[0]).toBe('schemaVersion');
    expect(written.schemaVersion).toBe(SCHEMA_VERSION);
  });
});

describe('checkSchema', () => {
  const withVersion = (schemaVersion: unknown) => ({ ...graph, schemaVersion });

  it('accepts graphs of this format version', () => {
    expect(checkSchema(graph)).toBeNull();
  });

  it('rejects a newer format version, naming the version that wrote it', () => {
    const problem = checkSchema(withVersion(SCHEMA_VERSION + 1));
    expect(problem?.kind).toBe('newer');
    expect(problem?.message).toContain(`format version ${SCHEMA_VERSION + 1}`);
    expect(problem?.message).toContain(`CodeMap ${pkg.version}`);
    expect(problem?.message).toMatch(/Update CodeMap/);
  });

  it.runIf(SCHEMA_VERSION > 1)('rejects an older format version', () => {
    expect(checkSchema(withVersion(SCHEMA_VERSION - 1))?.kind).toBe('older');
  });

  it('rejects a graph without a schema version', () => {
    const { schemaVersion: _, ...unversioned } = graph;
    const problem = checkSchema(unversioned);
    expect(problem?.kind).toBe('missing');
    expect(problem?.message).toContain(`CodeMap ${pkg.version}`);
    expect(problem?.message).toMatch(/regenerate/);
  });

  it('rejects files that are not a graph.json, and invalid versions', () => {
    for (const value of [null, 'graph', [], {}, { meta: {} }]) expect(checkSchema(value)?.kind).toBe('invalid');
    for (const v of ['1', 1.5, 0, null]) expect(checkSchema(withVersion(v))?.kind).toBe('invalid');
  });
});

describe('changelog', () => {
  it('reads the release sections of a Keep a Changelog file', () => {
    const text = '# Changelog\n\n## [Unreleased]\n\n### Added\n- x\n\n## [0.2.0] - 2026-11-02\n\n### Fixed\n- y\n\n## [0.1.0] - 2026-10-30\n';
    expect(changelogVersions(text)).toEqual(['0.2.0', '0.1.0']);
  });

  it('has an Unreleased section or one for the current version', () => {
    const text = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
    expect(/^## \[Unreleased\]/m.test(text) || changelogVersions(text).includes(pkg.version)).toBe(true);
  });

  it('stops a release whose version has no changelog section', () => {
    const run = spawnSync(process.execPath, [path.join(root, 'scripts', 'check-release.mjs')], {
      env: { ...process.env, npm_new_version: '999.0.0' },
      encoding: 'utf8',
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('## [999.0.0]');
  });
});
