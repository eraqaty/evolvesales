import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'] } },
  test: {
    // NestJS module compilation is slow on a cold start (notably on Windows/CI).
    testTimeout: 15_000,
    include: ['test/**/*.e2e-spec.ts'],
  },
});
