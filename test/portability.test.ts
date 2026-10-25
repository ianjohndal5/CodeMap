import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { analyze } from '../src/analyze.js';
import { defaultConfig } from '../src/config.js';
import type { Graph } from '../src/types.js';

// The same project must give the same graph.json on every OS. A Windows checkout usually has \r\n line ends,
// and some Windows editors save a byte-order mark: neither may change a node, an edge or a message.
const fixtures = path.resolve(__dirname, '..', 'fixtures');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codemap-crlf-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const BOM = String.fromCharCode(0xfeff);

/** Copy a project, as a Windows checkout when `windows`: \r\n line ends, and a BOM on JSON and some sources. */
function copyProject(from: string, to: string, windows: boolean): void {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) copyProject(src, dst, windows);
    else if (!windows) fs.copyFileSync(src, dst);
    else {
      const text = fs.readFileSync(src, 'utf8').replace(/\n/g, '\r\n');
      const bom = /\.json$/.test(e.name) || e.name.length % 2 === 0 ? BOM : '';
      fs.writeFileSync(dst, bom + text);
    }
  }
}

/** A URL expression over several lines: its quoted text must not pick up the \r. */
const MULTILINE = `export async function report(id: string) {
  return fetch(
    process.env.NEXT_PUBLIC_API_URL +
      '/api/reports/' +
      id +
      '/pdf',
  );
}
`;

/** graph.json without what legitimately differs between machines: timestamps, timings and absolute roots. */
function portable(g: Graph, root: string): string {
  const { generatedAt, durationMs, timings, ...meta } = g.meta;
  void [generatedAt, durationMs, timings];
  return JSON.stringify({ ...g, meta }).split(root).join('<root>');
}

describe('portability', () => {
  it('gives the same graph for a checkout with \\r\\n line ends and byte-order marks', () => {
    for (const [dir, windows] of [
      ['lf', false],
      ['crlf', true],
    ] as const) {
      copyProject(path.join(fixtures, 'laravel-security'), path.join(tmp, dir, 'laravel-security'), windows);
      copyProject(path.join(fixtures, 'next-security'), path.join(tmp, dir, 'next-security'), windows);
      const extra = windows ? MULTILINE.replace(/\n/g, '\r\n') : MULTILINE;
      fs.writeFileSync(path.join(tmp, dir, 'next-security', 'src', 'lib', 'report.ts'), extra);
    }
    const run = (root: string) =>
      analyze({ backend: path.join(root, 'laravel-security'), frontend: path.join(root, 'next-security'), config: defaultConfig(), security: true }).graph;
    const lf = run(path.join(tmp, 'lf'));
    const crlf = run(path.join(tmp, 'crlf'));
    // composer.json carries a BOM in the Windows copy: it is still read (PSR-4 resolution would break otherwise).
    expect(crlf.meta.warnings.filter((w) => /Could not parse|composer\.json/.test(w))).toEqual([]);
    expect(portable(crlf, path.join(tmp, 'crlf'))).toBe(portable(lf, path.join(tmp, 'lf')));
  });
});
