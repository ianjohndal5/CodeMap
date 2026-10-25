// The WebAssembly Tree-sitter runtime for setParserRuntime(): web-tree-sitter plus the grammars' own .wasm builds
// (same versions as the native ones). The caller passes web-tree-sitter in, so the CLI package doesn't depend on it.
import path from 'node:path';
import type { LangId, ParserRuntime } from './parse.js';

/** What this module uses of the `web-tree-sitter` package (0.25). */
export interface WebTreeSitter {
  Parser: { init(options?: object): Promise<void>; new (): unknown };
  Language: { load(file: string): Promise<unknown> };
  Query: new (language: unknown, source: string) => unknown;
}

/** The grammar files, as the grammar packages ship them. */
export const GRAMMAR_WASM: Record<LangId, string> = {
  php: 'tree-sitter-php.wasm',
  ts: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  js: 'tree-sitter-javascript.wasm',
};

/** Initialize web-tree-sitter and load the four grammars; `grammarFile` maps a file name to its path. */
export async function wasmRuntime(wts: WebTreeSitter, grammarFile: (name: string) => string): Promise<ParserRuntime> {
  await wts.Parser.init();
  const languages = {} as Record<LangId, unknown>;
  for (const [lang, file] of Object.entries(GRAMMAR_WASM) as [LangId, string][]) languages[lang] = await wts.Language.load(grammarFile(file));
  return { Parser: wts.Parser as unknown as ParserRuntime['Parser'], Query: wts.Query as unknown as ParserRuntime['Query'], languages };
}

/** All four grammar files in one folder (the extension's layout). */
export const inFolder = (dir: string) => (name: string) => path.join(dir, name);
