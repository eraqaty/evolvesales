import { z } from 'zod';

/**
 * Contract between the Orchestrator and the agent-runner container (§9).
 *
 * - The Orchestrator writes ONE JSON document to the container's stdin: `{ input, secrets }`.
 *   Secrets travel only this way: never in environment variables or labels (both are visible
 *   through `docker inspect`), never on disk outside the container's tmpfs.
 * - The runner writes one JSON event per stdout line. Only lines that parse as a
 *   `RunnerEvent` count; anything else is kept as plain log text.
 * - The last `result` event is the outcome. The Orchestrator validates it again; nothing the
 *   runner says is trusted without checking.
 */

export const RUNNER_PROTOCOL_VERSION = 1;

export const SHA_PATTERN = /^[0-9a-f]{40}$/;
export const REPO_FULL_NAME_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export const runnerInputSchema = z.object({
  protocol: z.literal(RUNNER_PROTOCOL_VERSION),
  mode: z.literal('analyze'),
  jobId: z.uuid(),
  repository: z.object({
    fullName: z.string().regex(REPO_FULL_NAME_PATTERN),
    /** https://github.com/<owner>/<name>.git (or the test server's equivalent). */
    cloneUrl: z.url({ protocol: /^https?$/ }),
  }),
  baselineSha: z.string().regex(SHA_PATTERN),
  changeRequest: z.object({
    key: z.string().max(20),
    title: z.string().max(200),
    originalRequest: z.string().max(8000),
    /** The validated ChangeRequestProposal the requester submitted. */
    structured: z.unknown(),
    screen: z.string().max(200),
    screenContext: z.unknown(),
  }),
  limits: z.object({
    maxTurns: z.number().int().min(1).max(200),
    maxBudgetUsd: z.number().positive().max(1000),
  }),
  model: z.string().min(1).max(100),
});
export type RunnerInput = z.infer<typeof runnerInputSchema>;

export const runnerSecretsSchema = z.object({
  githubToken: z.string().min(1),
  anthropicApiKey: z.string().min(1),
});
export type RunnerSecrets = z.infer<typeof runnerSecretsSchema>;

export const runnerStdinSchema = z.object({
  input: runnerInputSchema,
  secrets: runnerSecretsSchema,
});
export type RunnerStdin = z.infer<typeof runnerStdinSchema>;

const usageSchema = z.object({
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
});

export const runnerEventSchema = z.union([
  z.object({
    type: z.literal('log'),
    level: z.enum(['info', 'warn', 'error']),
    source: z.enum(['runner', 'agent']),
    message: z.string().max(4000),
  }),
  z.object({
    type: z.literal('result'),
    ok: z.literal(true),
    plan: z.unknown(),
    model: z.string().max(100),
    headSha: z.string().regex(SHA_PATTERN),
    numTurns: z.number().int().min(0),
    usage: usageSchema,
    costUsd: z.number().min(0),
  }),
  z.object({
    type: z.literal('result'),
    ok: z.literal(false),
    error: z.string().max(4000),
    usage: usageSchema.optional(),
    costUsd: z.number().min(0).optional(),
  }),
]);
export type RunnerEvent = z.infer<typeof runnerEventSchema>;
export type RunnerResultEvent = Extract<RunnerEvent, { type: 'result' }>;

/** Parses one stdout line; `null` when it is not a protocol event. */
export function parseRunnerEvent(line: string): RunnerEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = runnerEventSchema.safeParse(JSON.parse(trimmed));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Removes anything that looks like a credential before a line is stored or shown. */
export function redactSecrets(text: string): string {
  return text
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[redacted-github-token]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[redacted-github-token]')
    .replace(/\bsk-ant-[A-Za-z0-9_-]{10,}\b/g, '[redacted-anthropic-key]')
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[redacted-api-key]')
    .replace(/(x-access-token:)[^@\s]+@/g, '$1[redacted]@')
    .replace(/(authorization:\s*(?:bearer|token|basic)\s+)\S+/gi, '$1[redacted]');
}
