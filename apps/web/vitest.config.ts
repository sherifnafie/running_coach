import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.{test,spec}.{ts,tsx}'],
    environment: 'jsdom',
    testTimeout: 30_000,
    hookTimeout: 120_000,
    pool: 'forks',
  },
});
