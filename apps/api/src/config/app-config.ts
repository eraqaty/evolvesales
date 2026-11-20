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

  // ── AI Request Assistant (§6). Without a key the assistant answers 503 "not configured". ──
  LLM_PROVIDER: z.enum(['anthropic', 'openai']).default('anthropic'),
  LLM_MODEL: z.string().min(1).default('claude-sonnet-5-5'),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  ASSISTANT_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(20),
  /** Upper bound on LLM steps (tool calls + answer) per user message. */
  ASSISTANT_MAX_STEPS: z.coerce.number().int().min(1).max(10).default(5),
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

  /** The API key for the selected LLM provider, if one is configured. */
  get llmApiKey(): string | undefined {
    const key =
      this.env.LLM_PROVIDER === 'anthropic' ? this.env.ANTHROPIC_API_KEY : this.env.OPENAI_API_KEY;
    return key?.trim() ? key.trim() : undefined;
  }
}
