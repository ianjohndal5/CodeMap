import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractJs, type JsFileInfo, type JsHttpCandidate } from '../src/lang/js/extract.js';
import { nextFileInfo } from '../src/lang/js/next.js';
import { ModuleResolver } from '../src/lang/js/resolve.js';
import { type LangId, parseSource } from '../src/parse.js';
import type { UrlPart } from '../src/types.js';

const js = (src: string, lang: LangId = 'tsx', rel = 'src/x.tsx'): JsFileInfo => extractJs(rel, lang, parseSource(lang, src).rootNode);

/** Compact text form of URL alternatives: lit as-is, env as ${env:X}, others as ${...}. */
const urlText = (alts: UrlPart[][] | null) =>
  (alts ?? []).map((alt) =>
    alt
      .map((p) => (p.t === 'lit' ? p.v : p.t === 'env' ? `\${env:${p.name}}` : p.t === 'ident' ? `\${${p.name}}` : p.t === 'member' ? `\${${p.object}.${p.prop}}` : '${?}'))
      .join(''),
  );
const http = (h: JsHttpCandidate) => `${h.from || '<module>'} ${h.client.t === 'binding' ? h.client.name : h.client.t} ${h.method ?? '?'} ${urlText(h.url).join(' || ')}`;

describe('JS definitions', () => {
  it('extracts functions, arrow functions, classes, methods, object members and default exports', () => {
    const info = js(`
export function A() { return <div/>; }
const b = () => 1;
export const C = async function () {};
export default function Page() { return <main/>; }
class D extends Base { m() {} static n = () => 2; }
export const api = { list: () => 1, get(id) { return id; }, BASE: '/api' };
const Memo = memo(function Inner() { return <p/>; });
function A() {} // duplicate name
`);
    expect(info.defs.map((d) => `${d.kind} ${d.key}:${d.line}${d.jsx ? ' jsx' : ''}`)).toEqual([
      'function A:2 jsx',
      'function b:3',
      'function C:4',
      'function Page:5 jsx',
      'class D:6',
      'method D.m:6',
      'method D.n:6',
      'method api.list:7',
      'method api.get:7',
      'function Memo:8 jsx',
      'function A@9:9',
    ]);
    expect([...info.exports.entries()].map(([k, v]) => `${k}=${v.kind === 'local' ? v.local : v.source}`)).toEqual([
      'A=A',
      'C=C',
      'default=Page',
      'api=api',
    ]);
  });

  it('reads ES imports, re-exports, CommonJS and dynamic imports', () => {
    const info = js(
      `
import React, { useState as useS } from 'react';
import * as users from '@/lib/users';
import type { T } from './types';
import './globals.css';
export { a as b } from './a';
export * from './star';
export * as ns from './ns';
const legacy = require('./legacy');
const { one, two: deux } = require('./cjs');
const Lazy = dynamic(() => import('./Lazy'));
async function f() { await import('./later'); }
module.exports = { f };
exports.g = () => 1;
`,
      'js',
      'src/x.js',
    );
    expect(info.imports.map((i) => `${i.source} [${i.bindings.map((b) => `${b.local}=${b.imported}`).join(',')}]`)).toEqual([
      'react [React=default,useS=useState]',
      '@/lib/users [users=*]',
      './types [T=T]',
      './globals.css []',
      './a []',
      './star []',
      './ns []',
      './legacy [legacy=default]',
      './cjs [one=one,deux=two]',
      './Lazy [Lazy=default]',
      './later []',
    ]);
    expect(info.starExports).toEqual(['./star']);
    expect(info.exports.get('b')).toEqual({ kind: 'reexport', source: './a', imported: 'a' });
    expect(info.exports.get('ns')).toEqual({ kind: 'reexport', source: './ns', imported: '*' });
    expect(info.exports.get('f')).toEqual({ kind: 'local', local: 'f' });
    expect(info.exports.get('g')).toEqual({ kind: 'local', local: 'g' });
  });

  it('detects "use client" only in the directive prologue', () => {
    expect(js(`// comment\n'use client';\nexport const x = 1;`).useClient).toBe(true);
    expect(js(`export const x = 1;\n'use client';`).useClient).toBe(false);
  });
});

describe('JS calls', () => {
  it('records calls and JSX renders of module bindings, skipping shadowed names and globals', () => {
    const info = js(`
import { listUsers, Card } from '@/lib/users';
import * as api from '@/lib/api';
function helper() {}
export function Page({ listUsers: _l }) {
  helper();
  listUsers();
  api.fetchAll();
  console.log('x');
  const Card2 = Card;
  return <div><Card /><api.Widget/><span/></div>;
}
export function Shadow(helper) { helper(); }
`);
    expect(info.calls.map((c) => `${c.from} -> ${c.callee.t === 'id' ? c.callee.name : `${c.callee.object}.${c.callee.prop}`}${c.jsx ? ' (jsx)' : ''}`)).toEqual([
      'Page -> helper',
      'Page -> listUsers',
      'Page -> api.fetchAll',
      'Page -> Card (jsx)',
      'Page -> api.Widget (jsx)',
    ]);
  });
});

describe('HTTP call detection', () => {
  it('detects fetch with methods, env bases, templates, concatenation and ternaries', () => {
    const info = js(`
const API = process.env.NEXT_PUBLIC_API_URL;
export async function load(id, year) {
  const url = \`/api/items/\${id}\`;
  fetch(\`\${process.env.NEXT_PUBLIC_API_URL}/api/users/\${id}\`);
  fetch(API + '/api/posts', { method: 'post' });
  fetch('/api/session', { credentials: 'include' });
  fetch(url, init);
  fetch(year ? \`/api/reports/\${year}\` : '/api/reports');
  fetch(import.meta.env.VITE_API + '/x');
  window.fetch('/api/w');
}
`);
    expect(info.http.map(http)).toEqual([
      'load fetch GET ${env:NEXT_PUBLIC_API_URL}/api/users/${?}',
      'load fetch POST ${API}/api/posts',
      'load fetch GET /api/session',
      'load fetch ? /api/items/${?}',
      'load fetch GET /api/reports/${?} || /api/reports',
      'load fetch GET ${env:VITE_API}/x',
      'load fetch GET /api/w',
    ]);
    expect(info.top.get('API')).toEqual({ kind: 'url', parts: [[{ t: 'env', name: 'NEXT_PUBLIC_API_URL' }]] });
  });

  it('detects axios calls, axios(config) and instances created with axios.create', () => {
    const info = js(`
import Axios from 'axios';
import client from '@/lib/client';
const api = Axios.create({ baseURL: \`\${process.env.NEXT_PUBLIC_BACKEND_URL}/api\` });
export default api;
export function go() {
  Axios.get('/users');
  Axios({ url: '/login', method: 'post' });
  Axios.request({ url: '/r' });
  api.put('/users/1', {});
  api.delete(\`/users/\${1}\`);
  client.patch('/x');
  client.helper();
}
`);
    expect(info.http.map(http)).toEqual([
      'go axios GET /users',
      'go axios POST /login',
      'go axios GET /r',
      'go api PUT /users/1',
      'go api DELETE /users/${?}',
      'go client PATCH /x',
    ]);
    expect(info.top.get('api')).toEqual({
      kind: 'instance',
      base: [[{ t: 'env', name: 'NEXT_PUBLIC_BACKEND_URL' }, { t: 'lit', v: '/api' }]],
    });
    // client.patch may be an imported instance: kept as a candidate and confirmed at resolve time.
    expect(info.calls.map((c) => (c.callee.t === 'member' ? `${c.callee.object}.${c.callee.prop}` : c.callee.name))).toEqual(['client.patch', 'client.helper']);
  });

  it('ignores a locally shadowed fetch', () => {
    const info = js(`export function f() { const fetch = mock(); fetch('/api/x'); }`);
    expect(info.http).toEqual([]);
  });
});

describe('module resolution', () => {
  const files = new Set([
    'src/lib/axios.ts',
    'src/lib/users.ts',
    'src/components/index.ts',
    'src/components/Card.tsx',
    'src/utils/format.js',
    'src/legacy.ts',
  ]);
  const r = new ModuleResolver(files, { baseDir: '', hasBaseUrl: false, paths: [{ pattern: '@/*', targets: ['./src/*'] }] });

  it('resolves relative paths, extensions, index files and the @/ alias', () => {
    expect(r.resolve('src/app/page.tsx', '@/lib/axios')).toEqual({ kind: 'file', rel: 'src/lib/axios.ts' });
    expect(r.resolve('src/app/page.tsx', '@/components')).toEqual({ kind: 'file', rel: 'src/components/index.ts' });
    expect(r.resolve('src/components/index.ts', './Card')).toEqual({ kind: 'file', rel: 'src/components/Card.tsx' });
    expect(r.resolve('src/lib/users.ts', '../utils/format')).toEqual({ kind: 'file', rel: 'src/utils/format.js' });
    expect(r.resolve('src/lib/users.ts', '../legacy.js')).toEqual({ kind: 'file', rel: 'src/legacy.ts' });
  });

  it('classifies packages, assets and broken project imports', () => {
    expect(r.resolve('src/a.ts', 'react')).toEqual({ kind: 'external' });
    expect(r.resolve('src/a.ts', './styles.css')).toEqual({ kind: 'asset' });
    expect(r.resolve('src/a.ts', './missing')).toEqual({ kind: 'unresolved' });
    expect(r.resolve('src/a.ts', '@/nope')).toEqual({ kind: 'unresolved' });
  });

  it('tells excluded files and imports outside the project from broken imports', () => {
    // On disk but not among the scanned files (as when .gitignore'd or excluded by config).
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-excluded-'));
    fs.mkdirSync(path.join(root, 'src', 'generated'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'generated', 'ignored.ts'), 'export const x = 1;\n');
    const rx = new ModuleResolver(new Set(['src/app/page.tsx']), { baseDir: '', hasBaseUrl: false, paths: [{ pattern: '@/*', targets: ['./src/*'] }] }, root);
    expect(rx.resolve('src/app/page.tsx', '@/generated/ignored')).toEqual({ kind: 'excluded' });
    expect(rx.resolve('src/app/page.tsx', '../../../packages/shared/env')).toEqual({ kind: 'external' }); // climbs out of the project
    expect(rx.resolve('src/app/page.tsx', '@/nope')).toEqual({ kind: 'unresolved' });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('supports baseUrl imports', () => {
    const rb = new ModuleResolver(files, { baseDir: 'src', hasBaseUrl: true, paths: [] });
    expect(rb.resolve('src/app/page.tsx', 'lib/users')).toEqual({ kind: 'file', rel: 'src/lib/users.ts' });
  });
});

describe('Next.js conventions', () => {
  it('derives kinds and routes for the App Router and Pages Router', () => {
    expect(nextFileInfo('app/page.tsx')).toMatchObject({ nextKind: 'page', route: '/' });
    expect(nextFileInfo('src/app/(dashboard)/users/[id]/page.tsx')).toMatchObject({ nextKind: 'page', route: '/users/[id]' });
    expect(nextFileInfo('app/@modal/(.)photo/[id]/page.tsx')).toMatchObject({ nextKind: 'page', route: '/photo/[id]' });
    expect(nextFileInfo('app/api/users/[id]/route.ts')).toMatchObject({ nextKind: 'route', route: '/api/users/[id]' });
    expect(nextFileInfo('src/app/dashboard/layout.tsx')).toMatchObject({ nextKind: 'layout', route: '/dashboard' });
    expect(nextFileInfo('src/app/loading.tsx')).toMatchObject({ nextKind: 'loading' });
    expect(nextFileInfo('app/components/Button.tsx')).toEqual({ router: 'app' });
    expect(nextFileInfo('pages/index.tsx')).toMatchObject({ nextKind: 'page', route: '/' });
    expect(nextFileInfo('src/pages/blog/[slug].tsx')).toMatchObject({ nextKind: 'page', route: '/blog/[slug]' });
    expect(nextFileInfo('pages/api/hello.ts')).toMatchObject({ nextKind: 'api', route: '/api/hello' });
    expect(nextFileInfo('pages/_app.tsx')).toMatchObject({ nextKind: 'app' });
    expect(nextFileInfo('middleware.ts')).toMatchObject({ nextKind: 'middleware' });
    expect(nextFileInfo('src/lib/axios.ts')).toEqual({});
  });
});
