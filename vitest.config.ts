import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Native tree-sitter bindings are not safe to share across worker threads.
    pool: 'forks',
    // CODEMAP_PARSER=wasm runs the whole suite on the WebAssembly runtime (the editor extension's).
    setupFiles: process.env.CODEMAP_PARSER === 'wasm' ? ['test/setup-wasm.ts'] : [],
  },
});
