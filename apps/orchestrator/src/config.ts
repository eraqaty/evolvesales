import { readFileSync } from 'node:fs';
import { z } from 'zod';

const optional = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v ? v : undefined));

export const orchestratorEnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    APP_VERSION: z.string().default('dev'),
    ORCHESTRATOR_PORT: z.coerce.number().int().positive().default(3001),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

    // ── GitHub App (§11). Without these, analysis fails with "GitHub App not configured". ──
    GITHUB_APP_ID: optional,
    /** Path to the App's private key (.pem). The key itself never goes in .env. */
    GITHUB_APP_PRIVATE_KEY_PATH: optional,
    GITHUB_API_BASE_URL: z.url().default('https://api.github.com'),
    /** Base for clone URLs handed to the runner (tests point this at a local server). */
    GITHUB_CLONE_BASE_URL: z.url().default('https://github.com'),
    REPO_SYNC_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),

    // ── Analysis agent (§7, §9). ──
    ANTHROPIC_API_KEY: optional,
    AGENT_ANALYZE_MODEL: z.string().min(1).default('claude-opus-5-5'),
    AGENT_ANALYZE_MAX_TURNS: z.coerce.number().int().min(1).max(200).default(40),
    AGENT_ANALYZE_TIMEOUT_MINUTES: z.coerce.number().int().min(1).max(120).default(15),
    /** Runner image, ideally pinned by digest (evolvesales/agent-runner@sha256:…). */
    AGENT_RUNNER_IMAGE: optional,
    /** Docker endpoint: the docker-socket-proxy (tcp://127.0.0.1:2375). Empty = local socket. */
    AGENT_DOCKER_HOST: optional,
    /** Internal-only network the runner joins; its only way out is the egress proxy. */
    AGENT_NETWORK: z.string().min(1).default('evolvesales-agent-net'),
    AGENT_EGRESS_PROXY_URL: z.url().default('http://egress-proxy:3128'),
  })
  .superRefine((env, ctx) => {
    if (Boolean(env.GITHUB_APP_ID) !== Boolean(env.GITHUB_APP_PRIVATE_KEY_PATH)) {
      ctx.addIssue({
        code: 'custom',
        path: ['GITHUB_APP_PRIVATE_KEY_PATH'],
        message: 'Set both GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH, or neither',
      });
    }
    if (
      env.NODE_ENV === 'production' &&
      env.AGENT_RUNNER_IMAGE &&
      !env.AGENT_RUNNER_IMAGE.includes('@sha256:')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['AGENT_RUNNER_IMAGE'],
        message: 'In production the runner image must be pinned by digest (…@sha256:…)',
      });
    }
  });

export type OrchestratorEnv = z.infer<typeof orchestratorEnvSchema>;

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  apiBaseUrl: string;
  cloneBaseUrl: string;
}

export interface AgentRuntimeConfig {
  image: string;
  dockerHost: string | undefined;
  network: string;
  egressProxyUrl: string;
  anthropicApiKey: string;
  model: string;
  maxTurns: number;
  timeoutMs: number;
}

/** Validated configuration; fails fast at boot. */
export class OrchestratorConfig {
  readonly github: GitHubAppConfig | null;

  constructor(
    readonly env: OrchestratorEnv,
    readKey: (path: string) => string = (p) => readFileSync(p, 'utf8'),
  ) {
    this.github =
      env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY_PATH
        ? {
            appId: env.GITHUB_APP_ID,
            privateKey: readPrivateKey(env.GITHUB_APP_PRIVATE_KEY_PATH, readKey),
            apiBaseUrl: env.GITHUB_API_BASE_URL,
            cloneBaseUrl: env.GITHUB_CLONE_BASE_URL.replace(/\/+$/, ''),
          }
        : null;
  }

  /** What the analysis agent needs, or the reason it can't run (shown on the failed request). */
  get agentRuntime(): AgentRuntimeConfig | { missing: string } {
    const env = this.env;
    if (!env.ANTHROPIC_API_KEY) {
      return { missing: 'ANTHROPIC_API_KEY is not set for the Orchestrator' };
    }
    if (!env.AGENT_RUNNER_IMAGE) {
      return {
        missing:
          'AGENT_RUNNER_IMAGE is not set: build the runner image (pnpm runner:build) and set its digest',
      };
    }
    return {
      image: env.AGENT_RUNNER_IMAGE,
      dockerHost: env.AGENT_DOCKER_HOST,
      network: env.AGENT_NETWORK,
      egressProxyUrl: env.AGENT_EGRESS_PROXY_URL,
      anthropicApiKey: env.ANTHROPIC_API_KEY,
      model: env.AGENT_ANALYZE_MODEL,
      maxTurns: env.AGENT_ANALYZE_MAX_TURNS,
      timeoutMs: env.AGENT_ANALYZE_TIMEOUT_MINUTES * 60_000,
    };
  }

  static fromEnvironment(source: NodeJS.ProcessEnv = process.env): OrchestratorConfig {
    const parsed = orchestratorEnvSchema.safeParse(source);
    if (!parsed.success) {
      const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
      throw new Error(`Invalid configuration:\n${problems.join('\n')}`);
    }
    return new OrchestratorConfig(parsed.data);
  }
}

function readPrivateKey(path: string, readKey: (path: string) => string): string {
  let key: string;
  try {
    key = readKey(path);
  } catch {
    // The path is not secret; the file content is, so it is never echoed.
    throw new Error(`Invalid configuration:\n  - GITHUB_APP_PRIVATE_KEY_PATH: cannot read ${path}`);
  }
  if (!/-----BEGIN (RSA )?PRIVATE KEY-----/.test(key)) {
    throw new Error(
      'Invalid configuration:\n  - GITHUB_APP_PRIVATE_KEY_PATH: the file is not a PEM private key',
    );
  }
  return key;
}
