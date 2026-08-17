import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'node',
    // Server tests exercise the CLI/db/API in plain node; component tests under
    // test/web/ render React into a document, so only that subtree gets a DOM.
    environmentMatchGlobs: [['test/web/**', 'jsdom']],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary'],
    },
  },
});
