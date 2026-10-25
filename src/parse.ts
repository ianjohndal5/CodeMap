import fs from 'node:fs';
import path from 'node:path';
import type TreeSitter from 'tree-sitter';
import { loadNative } from './native.js';

const Parser = loadNative<typeof TreeSitter>('tree-sitter');
const PHP = loadNative<{ php: unknown }>('tree-sitter-php');
const TypeScript = loadNative<{ typescript: unknown; tsx: unknown }>('tree-sitter-typescript');
const JavaScript = loadNative<unknown>('tree-sitter-javascript');

export type LangId = 'php' | 'ts' | 'tsx' | 'js';
export type Tree = TreeSitter.Tree;
export type SyntaxNode = TreeSitter.SyntaxNode;

// `php` (not `php_only`) is the grammar for whole files: it accepts the leading
// `<?php` tag and any inline HTML around it.
const LANGUAGES: Record<LangId, unknown> = {
  php: PHP.php,
  ts: TypeScript.typescript,
  tsx: TypeScript.tsx,
  js: JavaScript,
};

const parsers = new Map<LangId, TreeSitter>();

function parserFor(lang: LangId): TreeSitter {
  let p = parsers.get(lang);
  if (!p) {
    p = new Parser();
    p.setLanguage(LANGUAGES[lang] as TreeSitter.Language);
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
  return parserFor(lang).parse(source);
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
    q = new Parser.Query(LANGUAGES[lang] as TreeSitter.Language, source);
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
    return { ok: false, rel, reason: `parse failed: ${(e as Error).message}` };
  }
}
