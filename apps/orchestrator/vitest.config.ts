import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['evolvesales-source'] },
  ssr: { resolve: { conditions: ['evolvesales-source'] } },
  test: {
    // NestJS module compilation is slow on a cold start (notably on Windows/CI).
    testTimeout: 15_000,
    include: ['src/**/*.spec.ts'],
  },
});
