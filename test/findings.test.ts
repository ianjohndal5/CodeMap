import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { analyze } from '../src/analyze.js';
import { defaultConfig, type SecurityOptions } from '../src/config.js';
import { matchFile, readSarif } from '../src/security/sarif.js';
import type { SecurityReport } from '../src/security/types.js';

const fixtures = path.resolve(__dirname, '..', 'fixtures');
const sample = path.join(fixtures, 'sarif', 'sample.sarif');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-sarif-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function lens(options: Partial<SecurityOptions> = {}): SecurityReport {
  const config = defaultConfig();
  Object.assign(config.security, options);
  return analyze({ backend: path.join(fixtures, 'laravel-security'), frontend: path.join(fixtures, 'next-security'), config, security: true }).graph.security!;
}

describe('SARIF reading', () => {
  it('reads rules, levels, severities, message strings, artifacts and suppressions', () => {
    const s = readSarif(sample);
    expect(s.error).toBeUndefined();
    expect(s.tools).toEqual(['Semgrep OSS', 'ESLint']);
    // The "pass" result is not a finding.
    expect(s.results).toHaveLength(5);
    const [sql, vendor, suppressed, danger, noLoc] = s.results;
    expect(sql).toMatchObject({ ruleId: 'php.laravel.security.laravel-sql-injection.laravel-sql-injection', level: 'error', severity: 8.1, line: 44, endLine: 44, column: 16 });
    expect(vendor).toMatchObject({ ruleId: 'php.lang.security.weak-crypto.weak-crypto', level: 'warning' }); // ruleIndex + default level
    expect(suppressed.suppressed).toBe(true);
    expect(danger).toMatchObject({ message: "Dangerous property 'dangerouslySetInnerHTML' found", uri: 'fixtures/next-security/src/components/InvoiceNote.tsx', line: 11 });
    expect(noLoc).toMatchObject({ uri: null, level: 'note' });
  });

  it('reports unreadable files instead of throwing', () => {
    const bad = path.join(tmp, 'bad.sarif');
    fs.writeFileSync(bad, '{ not json');
    expect(readSarif(bad).error).toMatch(/could not read SARIF/);
    fs.writeFileSync(bad, '{"version":"2.1.0"}');
    expect(readSarif(bad).error).toMatch(/no "runs" array/);
    expect(readSarif(path.join(tmp, 'missing.sarif')).error).toMatch(/could not read SARIF/);
  });
});

describe('SARIF path matching', () => {
  const roots = { backend: '/repo/api', frontend: '/repo/web' };
  const files = { backend: new Set(['app/Http/Controllers/UserController.php', 'routes/api.php']), frontend: new Set(['src/app/page.tsx', 'src/lib/api.ts']) };

  it('matches exact, suffix, absolute and file:// locations', () => {
    expect(matchFile('routes/api.php', roots, files)).toEqual({ side: 'backend', rel: 'routes/api.php' });
    expect(matchFile('./src/lib/api.ts', roots, files)).toEqual({ side: 'frontend', rel: 'src/lib/api.ts' });
    expect(matchFile('api/app/Http/Controllers/UserController.php', roots, files)).toEqual({ side: 'backend', rel: 'app/Http/Controllers/UserController.php' });
    expect(matchFile('/repo/web/src/app/page.tsx', roots, files)).toEqual({ side: 'frontend', rel: 'src/app/page.tsx' });
    expect(matchFile('file:///repo/api/routes/api.php', roots, files)).toEqual({ side: 'backend', rel: 'routes/api.php' });
    expect(matchFile('src/app/page%2Etsx', roots, files)).toEqual({ side: 'frontend', rel: 'src/app/page.tsx' });
  });

  it('explains what it cannot place', () => {
    expect(matchFile('/repo/api/vendor/x.php', roots, files)).toEqual({ reason: 'file not among the analyzed sources' });
    expect(matchFile('/elsewhere/x.php', roots, files)).toEqual({ reason: 'outside both projects' });
    expect(matchFile('https://example.com/x.js', roots, files)).toEqual({ reason: 'non-file URI' });
    const twins = { backend: new Set(['a/util.ts']), frontend: new Set(['b/util.ts']) };
    expect(matchFile('util.ts', roots, twins)).toEqual({ reason: 'ambiguous path (2 candidates)' });
  });
});

describe('findings on the map', () => {
  const report = lens({ sarif: [sample] });
  const sarif = report.findings.filter((f) => f.origin === 'sarif');

  it('places SARIF results on the innermost definition and keeps the rest visible', () => {
    expect(report.imports).toEqual([{ file: sample, tools: ['Semgrep OSS', 'ESLint'], results: 5, placed: 3, outside: 2, suppressed: 1 }]);
    const placed = Object.fromEntries(sarif.filter((f) => f.node).map((f) => [f.ruleId + (f.suppressed ? ' (suppressed)' : ''), f.node]));
    expect(placed).toEqual({
      'php.laravel.security.laravel-sql-injection.laravel-sql-injection': 'be:App\\Http\\Controllers\\BillingController::search',
      'php.lang.security.weak-crypto.weak-crypto (suppressed)': 'be:App\\Http\\Controllers\\AccountController::signup',
      'react/no-danger': 'fe:src/components/InvoiceNote.tsx#InvoiceNote',
    });
    expect(sarif.filter((f) => !f.node).map((f) => f.outside).sort()).toEqual(['file not among the analyzed sources', 'no location']);
  });

  it('adds context: reaching endpoints with their protection, frontend callers, and pages', () => {
    const sql = sarif.find((f) => f.ruleId.includes('sql-injection'))!;
    expect(sql).toMatchObject({ severity: 8.1, level: 'error', side: 'backend', file: 'app/Http/Controllers/BillingController.php', line: 44 });
    expect(sql.endpoints).toEqual([{ id: 'endpoint:laravel:GET /api/billing/search', via: 'definition', distance: 1, state: 'authenticated' }]);
    expect(sql.callers).toEqual(['fe:src/app/billing/page.tsx#BillingPage']);
    expect(sql.path).toEqual(['endpoint:laravel:GET /api/billing/search', 'be:App\\Http\\Controllers\\BillingController::search']);
    const danger = sarif.find((f) => f.ruleId === 'react/no-danger' && f.node)!;
    expect(danger.endpoints).toEqual([]);
    expect(danger.entries).toEqual(['fe:src/app/billing/page.tsx']);
    const ep = report.endpoints.find((e) => e.id === 'endpoint:laravel:GET /api/billing/search')!;
    expect(ep.findings).toBe(2); // the SARIF result and CodeMap's own raw-SQL check
  });

  it('gives findings stable, sorted ids', () => {
    const ids = report.findings.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('sarif/Semgrep OSS/php.laravel.security.laravel-sql-injection.laravel-sql-injection@app/Http/Controllers/BillingController.php:44');
    expect(JSON.stringify(lens({ sarif: [sample] }).findings)).toBe(JSON.stringify(report.findings));
  });

  it('accepts absolute file:// URIs from scanners run elsewhere', () => {
    const abs = path.join(tmp, 'abs.sarif');
    const uri = pathToFileURL(path.join(fixtures, 'next-security', 'src', 'lib', 'auth.ts')).href;
    fs.writeFileSync(abs, JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'X' } }, results: [{ ruleId: 'r', message: { text: 'm' }, locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: 8 } } }] }] }] }));
    const f = lens({ sarif: [abs], checks: false }).findings;
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ file: 'src/lib/auth.ts', node: 'fe:src/lib/auth.ts#signup' });
  });
});

describe('local checks', () => {
  const report = lens();
  const hits = report.findings.filter((f) => f.origin === 'check').map((f) => `${f.ruleId} ${f.confidence} ${f.file}:${f.line}`);

  it('flags each intended case once and none of the negatives', () => {
    expect(hits).toEqual([
      'laravel.mass-assignment high app/Http/Controllers/BillingController.php:16',
      'laravel.mass-assignment high app/Http/Controllers/BillingController.php:22',
      'laravel.raw-sql-request-input high app/Http/Controllers/BillingController.php:44',
      'laravel.raw-sql-request-input medium app/Http/Controllers/BillingController.php:52',
      'react.dangerously-set-inner-html medium src/components/InvoiceNote.tsx:11',
      'js.token-in-web-storage medium src/lib/auth.ts:8',
      'next.public-env-secret high src/lib/auth.ts:16',
    ]);
    expect(report.checks.rules.map((r) => [r.id, r.hits])).toEqual([
      ['laravel.mass-assignment', 2],
      ['laravel.raw-sql-request-input', 2],
      ['react.dangerously-set-inner-html', 1],
      ['js.token-in-web-storage', 1],
      ['next.public-env-secret', 1],
    ]);
    expect(report.checks.skipped.map((s) => s.id)).toEqual(['eval / new Function']);
  });

  it('explains each hit and attaches it like a SARIF result', () => {
    const mass = report.findings.find((f) => f.ruleId === 'laravel.mass-assignment' && f.line === 16)!;
    expect(mass.message).toMatch(/Invoice sets \$guarded = \[\]/);
    expect(mass).toMatchObject({ tool: 'codemap', node: 'be:App\\Http\\Controllers\\BillingController::store' });
    expect(mass.endpoints.map((e) => e.id)).toEqual(['endpoint:laravel:POST /api/billing/invoices']);
  });

  it('can be switched off entirely or per rule', () => {
    expect(lens({ checks: false }).findings).toEqual([]);
    expect(lens({ disableChecks: ['laravel.mass-assignment', 'next.public-env-secret'] }).findings.map((f) => f.ruleId)).not.toContain('laravel.mass-assignment');
  });
});
