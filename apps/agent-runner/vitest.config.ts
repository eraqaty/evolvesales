import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['evolvesales-source'] },
  ssr: { resolve: { conditions: ['evolvesales-source'] } },
  test: { include: ['src/**/*.spec.ts'] },
});
