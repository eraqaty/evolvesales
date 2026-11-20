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
  /** Per-IP limit for phone-link and approval-PIN changes on the Profile page. */
  PROFILE_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().min(1).default(15),

  // ── AI Request Assistant (§6). Without a key the assistant answers 503 "not configured". ──
  LLM_PROVIDER: z.enum(['anthropic', 'openai']).default('anthropic'),
  LLM_MODEL: z.string().min(1).default('claude-sonnet-5-5'),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  ASSISTANT_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(20),
  /** Upper bound on LLM steps (tool calls + answer) per user message. */
  ASSISTANT_MAX_STEPS: z.coerce.number().int().min(1).max(10).default(5),

  // ── WhatsApp channel (§19). Off unless WHATSAPP_ENABLED=true and the credentials are set. ──
  WHATSAPP_ENABLED: booleanString.default(false),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  WHATSAPP_WABA_ID: z.string().optional(),
  WHATSAPP_ACCESS_TOKEN: z.string().optional(),
  /** Meta App Secret: verifies X-Hub-Signature-256 on every webhook call. */
  WHATSAPP_APP_SECRET: z.string().optional(),
  /** Any random string; Meta echoes it when you register the webhook. */
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  /** Signs approval-card buttons. Defaults to a key derived from JWT_ACCESS_SECRET. */
  WHATSAPP_ACTION_SECRET: z.string().min(32).optional(),
  WHATSAPP_GRAPH_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/)
    .default('v23.0'),
  WHATSAPP_GRAPH_BASE_URL: z.url().default('https://graph.facebook.com'),
  /** The bot's number as users dial it (E.164), shown on the Profile page. */
  WHATSAPP_DISPLAY_NUMBER: z.string().optional(),
  WHATSAPP_TEMPLATE_LANGUAGE: z.string().default('en_US'),
  /** How often the notification dispatcher looks for new notifications; 0 turns the timer off. */
  WHATSAPP_DISPATCH_INTERVAL_MS: z.coerce.number().int().min(0).default(3000),
  /** How often the API's channel worker polls for inbound messages (pg-boss, seconds). */
  WHATSAPP_WORKER_POLL_SECONDS: z.coerce.number().min(0.5).default(1),
  /** Public address of the web app, used in links sent to phones. */
  PUBLIC_WEB_URL: z.url().optional(),
});

export type Env = z.infer<typeof envSchema>;

export interface WhatsAppConfig {
  phoneNumberId: string;
  accessToken: string;
  appSecret: string;
  verifyToken: string;
  graphUrl: string;
  displayNumber: string | null;
  templateLanguage: string;
}

const WHATSAPP_REQUIRED = [
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_VERIFY_TOKEN',
] as const;

/** Typed, validated configuration. Injected by class token. */
export class AppConfig {
  constructor(readonly env: Env) {}

  static fromEnvironment(source: NodeJS.ProcessEnv = process.env): AppConfig {
    const parsed = envSchema
      .superRefine((env, ctx) => {
        if (!env.WHATSAPP_ENABLED) return;
        for (const key of WHATSAPP_REQUIRED) {
          if (!env[key]?.trim()) {
            ctx.addIssue({
              code: 'custom',
              path: [key],
              message: 'required when WHATSAPP_ENABLED',
            });
          }
        }
      })
      .safeParse(source);
    if (!parsed.success) {
      const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
      throw new Error(`Invalid configuration:\n${problems.join('\n')}`);
    }
    return new AppConfig(parsed.data);
  }

  get isProduction(): boolean {
    return this.env.NODE_ENV === 'production';
  }

  /** WhatsApp settings when the channel is enabled, otherwise null. */
  get whatsapp(): WhatsAppConfig | null {
    const e = this.env;
    if (!e.WHATSAPP_ENABLED) return null;
    return {
      phoneNumberId: (e.WHATSAPP_PHONE_NUMBER_ID ?? '').trim(),
      accessToken: (e.WHATSAPP_ACCESS_TOKEN ?? '').trim(),
      appSecret: (e.WHATSAPP_APP_SECRET ?? '').trim(),
      verifyToken: (e.WHATSAPP_VERIFY_TOKEN ?? '').trim(),
      graphUrl: `${e.WHATSAPP_GRAPH_BASE_URL.replace(/\/$/, '')}/${e.WHATSAPP_GRAPH_VERSION}`,
      displayNumber: e.WHATSAPP_DISPLAY_NUMBER?.trim() || null,
      templateLanguage: e.WHATSAPP_TEMPLATE_LANGUAGE,
    };
  }

  /** Base URL for links sent outside the browser (WhatsApp). */
  get publicWebUrl(): string {
    return (this.env.PUBLIC_WEB_URL ?? this.env.WEB_ORIGIN).replace(/\/$/, '');
  }

  /** The API key for the selected LLM provider, if one is configured. */
  get llmApiKey(): string | undefined {
    const key =
      this.env.LLM_PROVIDER === 'anthropic' ? this.env.ANTHROPIC_API_KEY : this.env.OPENAI_API_KEY;
    return key?.trim() ? key.trim() : undefined;
  }
}
