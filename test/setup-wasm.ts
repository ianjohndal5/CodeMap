// CODEMAP_PARSER=wasm: run every test on the WebAssembly runtime the editor extension uses (vitest.config.ts).
import path from 'node:path';
import * as wts from 'web-tree-sitter';
import { setParserRuntime } from '../src/parse.js';
import { wasmRuntime } from '../src/wasm-runtime.js';

const modules = path.resolve(__dirname, '..', 'node_modules');
const where: Record<string, string> = {
  'tree-sitter-php.wasm': 'tree-sitter-php',
  'tree-sitter-typescript.wasm': 'tree-sitter-typescript',
  'tree-sitter-tsx.wasm': 'tree-sitter-typescript',
  'tree-sitter-javascript.wasm': 'tree-sitter-javascript',
};
setParserRuntime(await wasmRuntime(wts, (name) => path.join(modules, where[name]!, name)));
