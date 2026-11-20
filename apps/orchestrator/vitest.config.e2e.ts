import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['evolvesales-source'] },
  ssr: { resolve: { conditions: ['evolvesales-source'] } },
  test: {
    include: ['test/**/*.e2e-spec.ts'],
    globalSetup: ['./test/global-setup.ts'],
    // All files share one database container; run them one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});
