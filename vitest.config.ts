import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Native tree-sitter bindings are not safe to share across worker threads.
    pool: 'forks',
  },
});
