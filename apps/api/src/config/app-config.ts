import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_VERSION: z.string().default('dev'),
  API_PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(30).default(7),
  WEB_ORIGIN: z.url().default('http://localhost:5173'),
  COOKIE_SECURE: booleanString.default(true),
  LOGIN_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(10),
  LOGIN_MAX_FAILURES: z.coerce.number().int().min(1).default(10),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1).default(15),
});

export type Env = z.infer<typeof envSchema>;

/** Typed, validated configuration. Injected by class token. */
export class AppConfig {
  constructor(readonly env: Env) {}

  static fromEnvironment(source: NodeJS.ProcessEnv = process.env): AppConfig {
    const parsed = envSchema.safeParse(source);
    if (!parsed.success) {
      const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
      throw new Error(`Invalid configuration:\n${problems.join('\n')}`);
    }
    return new AppConfig(parsed.data);
  }

  get isProduction(): boolean {
    return this.env.NODE_ENV === 'production';
  }
}
