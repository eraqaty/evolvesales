import { z } from 'zod';

export const orchestratorEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_VERSION: z.string().default('dev'),
  ORCHESTRATOR_PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
});

export type OrchestratorEnv = z.infer<typeof orchestratorEnvSchema>;

/** Validated configuration; fails fast at boot. */
export class OrchestratorConfig {
  constructor(readonly env: OrchestratorEnv) {}

  static fromEnvironment(source: NodeJS.ProcessEnv = process.env): OrchestratorConfig {
    const parsed = orchestratorEnvSchema.safeParse(source);
    if (!parsed.success) {
      const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
      throw new Error(`Invalid configuration:\n${problems.join('\n')}`);
    }
    return new OrchestratorConfig(parsed.data);
  }
}
