import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';

// The single .env lives at the repository root. Real environment variables win.
loadEnv({ path: path.resolve(import.meta.dirname, '../../.env'), quiet: true });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx --conditions=source prisma/seed.ts',
  },
  datasource: {
    // Not `env()`: `prisma generate` must work in CI without a database URL.
    url: process.env.DATABASE_URL ?? '',
  },
});
