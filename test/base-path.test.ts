import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { analyze } from '../src/analyze.js';
import { defaultConfig } from '../src/config.js';
import { extractJs } from '../src/lang/js/extract.js';
import { normalizeCallUrl } from '../src/match/url.js';
import { parseSource } from '../src/parse.js';
import type { UrlPart } from '../src/types.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-base-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(root: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
}

const lit = (v: string): UrlPart => ({ t: 'lit', v });
const opts = { backendEnvVars: [], backendHosts: [] };

describe('backend base path', () => {
  it('reads the path of a literal fallback next to an env var', () => {
    const info = extractJs(
      'src/a.ts',
      'ts',
      parseSource('ts', `export async function load() {
  const base = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000/api/";
  const ads = process.env.NEXT_PUBLIC_ADS_URL ?? 'https://ads.example.com';
  await fetch(\`\${base}/v1/articles\`);
  await fetch(\`\${ads}/slots\`);
}`).rootNode,
    );
    expect(info.http.map((h) => h.url![0][0])).toEqual([
      { t: 'env', name: 'NEXT_PUBLIC_API_URL', basePath: '/api' },
      { t: 'env', name: 'NEXT_PUBLIC_ADS_URL' }, // a fallback without a path adds nothing
    ]);
  });

  it('puts the base path in front of backend URLs: config, then the fallback, then the project-wide value', () => {
    const inferred: UrlPart = { t: 'env', name: 'NEXT_PUBLIC_API_URL', basePath: '/api' };
    const plain: UrlPart = { t: 'env', name: 'NEXT_PUBLIC_API_URL' };
    expect(normalizeCallUrl([inferred, lit('/v1/articles')], opts)?.display).toBe('/api/v1/articles');
    expect(normalizeCallUrl([plain, lit('/v1/articles')], opts)?.display).toBe('/v1/articles');
    expect(normalizeCallUrl([plain, lit('/v1/articles')], { ...opts, inferredBasePaths: new Map([['NEXT_PUBLIC_API_URL', '/api']]) })?.display).toBe('/api/v1/articles');
    expect(normalizeCallUrl([plain, lit('/v1/articles')], { ...opts, backendBasePath: '/api/' })?.display).toBe('/api/v1/articles');
    expect(normalizeCallUrl([inferred, lit('/v1/articles')], { ...opts, backendBasePath: { NEXT_PUBLIC_API_URL: '/v2' } })?.display).toBe('/v2/v1/articles');
    expect(normalizeCallUrl([inferred, lit('/x')], { ...opts, backendBasePath: { OTHER: '/v2' } })?.display).toBe('/api/x');
    expect(normalizeCallUrl([{ t: 'base', name: 'API_URL' }, lit('/x')], { ...opts, backendBasePath: { API_URL: '/api' } })?.display).toBe('/api/x');
    // Absolute URLs spell out their own path: no base path is added.
    expect(normalizeCallUrl([lit('http://localhost:8000/api/x')], { ...opts, backendBasePath: '/api' })?.display).toBe('/api/x');
  });

  it('links calls through an env var whose /api lives in .env, using a fallback written elsewhere', () => {
    const root = path.join(tmp, 'mono');
    write(root, {
      'api/composer.json': JSON.stringify({ autoload: { 'psr-4': { 'App\\': 'app/' } } }),
      'api/artisan': '',
      'api/routes/api.php': `<?php
use Illuminate\\Support\\Facades\\Route;
Route::get('/v1/articles', fn () => []);
Route::post('/v1/subscribe', fn () => []);`,
      'web/package.json': JSON.stringify({ dependencies: { next: '16.0.0' } }),
      'web/lib/http.ts': `import axios from 'axios';
const baseURL = process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:8000/api";
export const http = axios.create({ baseURL });
export const listArticles = () => http.get('/v1/articles');`,
      'web/components/Subscribe.tsx': `export function Subscribe() {
  const send = () => fetch(\`\${process.env.NEXT_PUBLIC_API_URL}/v1/subscribe\`, { method: 'POST' });
  return <button onClick={send}>Subscribe</button>;
}`,
    });
    const graph = analyze({ backend: path.join(root, 'api'), frontend: path.join(root, 'web'), config: defaultConfig() }).graph;
    const http = graph.edges.filter((e) => e.kind === 'http').map((e) => `${e.source} -> ${e.target}`);
    expect(http).toEqual([
      'fe:components/Subscribe.tsx#Subscribe -> endpoint:laravel:POST /api/v1/subscribe',
      'fe:lib/http.ts#listArticles -> endpoint:laravel:GET /api/v1/articles',
    ]);
    expect(graph.meta.stats.unmatchedHttpCalls).toBe(0);
  });
});
