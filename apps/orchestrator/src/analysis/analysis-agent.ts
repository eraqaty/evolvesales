import type { RunnerInput } from '@evolvesales/shared';
import type { LogLevel, LogSource } from './job-log.writer.js';

/** Everything one analysis needs (§7). The token is read-only and scoped to one repository. */
export interface AnalysisRequest {
  jobId: string;
  changeRequest: RunnerInput['changeRequest'];
  repository: RunnerInput['repository'];
  baselineSha: string;
  githubToken: string;
  maxBudgetUsd: number;
  log: (level: LogLevel, source: LogSource, message: string) => void;
}

export interface AnalysisUsage {
  inputTokens: number;
  outputTokens: number;
}

interface Common {
  agent: string;
  model: string | null;
  usage: AnalysisUsage | null;
  costUsd: number | null;
  containerId: string | null;
  imageDigest: string | null;
}

export type AnalysisOutcome =
  | (Common & { ok: true; plan: unknown; headSha: string; numTurns: number })
  | (Common & { ok: false; error: string; timedOut: boolean });

export abstract class AnalysisAgent {
  abstract readonly kind: string;
  /** Why the agent can't run right now (missing key, image…), or null when it is ready. */
  abstract notReadyReason(): string | null;
  abstract analyze(request: AnalysisRequest): Promise<AnalysisOutcome>;
}
