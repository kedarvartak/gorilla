import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The root tsconfig leaves `jsx` unset, which is right for the server but makes
  // esbuild emit classic React.createElement calls for .tsx tests - and then fail
  // on `React is not defined`. The automatic runtime needs no import.
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'node',
    // Server tests exercise the CLI/db/API in plain node; component tests under
    // test/web/ render React into a document, so only that subtree gets a DOM.
    environmentMatchGlobs: [['test/web/**', 'jsdom']],
    // Sets IS_REACT_ACT_ENVIRONMENT. Without it React declines to run act() and
    // only warns, so a component test can pass while asserting on a tree that
    // was never committed.
    setupFiles: ['test/web/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary'],
    },
  },
});
