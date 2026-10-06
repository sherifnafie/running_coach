import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['seed/**/*.test.ts', 'packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts', 'apps/server/src/**/*.test.ts', 'apps/server/test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
  },
});
