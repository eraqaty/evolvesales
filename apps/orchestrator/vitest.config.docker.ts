import { defineConfig } from 'vitest/config';

/** Real-Docker tests (agent container isolation, §9). No database needed. */
export default defineConfig({
  resolve: { conditions: ['evolvesales-source'] },
  ssr: { resolve: { conditions: ['evolvesales-source'] } },
  test: {
    include: ['test/**/*.docker-spec.ts'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 300_000,
  },
});
