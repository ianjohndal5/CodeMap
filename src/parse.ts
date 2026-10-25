import fs from 'node:fs';
import path from 'node:path';
import type TreeSitter from 'tree-sitter';
import { loadNative } from './native.js';

export type LangId = 'php' | 'ts' | 'tsx' | 'js';
export type Tree = TreeSitter.Tree;
export type SyntaxNode = TreeSitter.SyntaxNode;

/**
 * The Tree-sitter runtime: the native binding (the default, used by the CLI) or WebAssembly (`web-tree-sitter`,
 * installed by the editor extension). Both run the same grammar versions and produce the same graph.json.
 */
export interface ParserRuntime {
  Parser: new () => { setLanguage(language: unknown): void; parse(source: string): Tree | null };
  Query: new (language: unknown, source: string) => TreeSitter.Query;
  /** `php` (not `php_only`) for whole files: it accepts the leading `<?php` tag and inline HTML around it. */
  languages: Record<LangId, unknown>;
}

let runtime: ParserRuntime | null = null;

/** Use another runtime than the native binding (the extension's WebAssembly one). Call it before anything is parsed. */
export function setParserRuntime(r: ParserRuntime): void {
  if (parsers.size || queries.size) throw new Error('setParserRuntime() must be called before the first parse');
  runtime = r;
}

/** The runtime in use; the native binding is loaded on first use, so a WebAssembly-only package never needs it. */
function current(): ParserRuntime {
  if (runtime) return runtime;
  const Parser = loadNative<typeof TreeSitter>('tree-sitter');
  const PHP = loadNative<{ php: unknown }>('tree-sitter-php');
  const TypeScript = loadNative<{ typescript: unknown; tsx: unknown }>('tree-sitter-typescript');
  const JavaScript = loadNative<unknown>('tree-sitter-javascript');
  runtime = {
    Parser: Parser as unknown as ParserRuntime['Parser'],
    Query: Parser.Query as unknown as ParserRuntime['Query'],
    languages: { php: PHP.php, ts: TypeScript.typescript, tsx: TypeScript.tsx, js: JavaScript },
  };
  return runtime;
}

const parsers = new Map<LangId, InstanceType<ParserRuntime['Parser']>>();

function parserFor(lang: LangId): InstanceType<ParserRuntime['Parser']> {
  let p = parsers.get(lang);
  if (!p) {
    const rt = current();
    p = new rt.Parser();
    p.setLanguage(rt.languages[lang]);
    parsers.set(lang, p);
  }
  return p;
}

export function langForFile(file: string): LangId | null {
  switch (path.extname(file).toLowerCase()) {
    case '.php':
      return 'php';
    case '.ts':
    case '.mts':
    case '.cts':
      return 'ts';
    case '.tsx':
    case '.jsx':
      return 'tsx';
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'js';
    default:
      return null;
  }
}

export function parseSource(lang: LangId, source: string): Tree {
  const tree = parserFor(lang).parse(source);
  if (!tree) throw new Error('the parser returned no tree');
  return tree;
}

const queries = new Map<string, TreeSitter.Query>();

/**
 * Compile (once) a Tree-sitter query from .scm files that sit next to the calling
 * module. Several files are concatenated, so grammars can share query files.
 */
export function loadQuery(lang: LangId, base: string | URL, ...files: string[]): TreeSitter.Query {
  const key = `${lang}\u0000${String(base)}\u0000${files.join('+')}`;
  let q = queries.get(key);
  if (!q) {
    const source = files.map((f) => fs.readFileSync(new URL(f, base), 'utf8')).join('\n');
    const rt = current();
    q = new rt.Query(rt.languages[lang], source);
    queries.set(key, q);
  }
  return q;
}

const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * A source file as text, the same on every OS: no byte-order mark, and \n line ends (a Windows checkout
 * often has \r\n, which would otherwise end up in texts quoted from the code).
 */
export function readSource(abs: string): string {
  let source = fs.readFileSync(abs, 'utf8');
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
  return source.includes('\r') ? source.replace(/\r\n?/g, '\n') : source;
}

/** Heuristic for bundled/minified JS that slipped past the *.min.js filter. */
export function looksMinified(source: string): boolean {
  if (source.length < 20_000) return false;
  let lines = 1;
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) lines++;
  return source.length / lines > 500;
}

export interface ParsedFile {
  rel: string;
  abs: string;
  lang: LangId;
  source: string;
  tree: Tree;
  hasError: boolean;
}

export type ParseOutcome = { ok: true; file: ParsedFile } | { ok: false; rel: string; reason: string; skipped?: boolean };

/** Read and parse one file. Never throws: failures are returned so the run can continue. */
export function parseFile(root: string, rel: string): ParseOutcome {
  const lang = langForFile(rel);
  if (!lang) return { ok: false, rel, reason: 'unsupported extension', skipped: true };
  const abs = path.join(root, rel);
  let source: string;
  try {
    const st = fs.statSync(abs);
    if (st.size > MAX_FILE_BYTES) return { ok: false, rel, reason: `larger than ${MAX_FILE_BYTES} bytes`, skipped: true };
    source = readSource(abs);
  } catch (e) {
    return { ok: false, rel, reason: `read failed: ${(e as Error).message}` };
  }
  if (lang !== 'php' && looksMinified(source)) return { ok: false, rel, reason: 'minified', skipped: true };
  try {
    const tree = parseSource(lang, source);
    return { ok: true, file: { rel, abs, lang, source, tree, hasError: tree.rootNode.hasError } };
  } catch (e) {
    // The WebAssembly runtime aborts when its fixed memory (2 GiB) runs out, and every later parse fails too:
    // stop instead of returning a map with the rest of the project missing.
    const RuntimeError = (globalThis as { WebAssembly?: { RuntimeError: abstract new () => Error } }).WebAssembly?.RuntimeError;
    if (RuntimeError && e instanceof RuntimeError) {
      throw new Error(`The parser ran out of memory at ${rel}, so the analysis stopped. This project is too large for the WebAssembly parser; the command-line tool has no such limit.`);
    }
    return { ok: false, rel, reason: `parse failed: ${(e as Error).message}` };
  }
}
