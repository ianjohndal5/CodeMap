import { describe, expect, it } from 'vitest';
import { parseSource } from '../src/parse.js';

describe('parser runtime', () => {
  it(`parses with the ${process.env.CODEMAP_PARSER === 'wasm' ? 'WebAssembly' : 'native'} runtime`, () => {
    const tree = parseSource('js', 'const a = 1;') as unknown as { delete?: unknown; rootNode: { type: string } };
    expect(tree.rootNode.type).toBe('program');
    // Only web-tree-sitter trees hold WebAssembly memory that must be freed explicitly.
    expect(typeof tree.delete === 'function').toBe(process.env.CODEMAP_PARSER === 'wasm');
  });
});
