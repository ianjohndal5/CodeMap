import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseFile, setParserRuntime } from '../src/parse.js';
import type { ParserRuntime } from '../src/parse.js';

// A runtime that fails like web-tree-sitter does when its memory is exhausted: every parse throws a WebAssembly
// RuntimeError ("Aborted()") from then on.
const RuntimeError = (globalThis as unknown as { WebAssembly: { RuntimeError: new (m: string) => Error } }).WebAssembly.RuntimeError;
class AbortedParser {
  setLanguage() {}
  parse(): never {
    throw new RuntimeError('Aborted()');
  }
}
setParserRuntime({ Parser: AbortedParser, Query: class {} as unknown as ParserRuntime['Query'], languages: { php: {}, ts: {}, tsx: {}, js: {} } } as unknown as ParserRuntime);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seammap-abort-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('a parser runtime that runs out of memory', () => {
  it('stops the analysis instead of skipping the rest of the project', () => {
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;');
    expect(() => parseFile(dir, 'a.ts')).toThrow(/ran out of memory at a\.ts/);
  });
});
