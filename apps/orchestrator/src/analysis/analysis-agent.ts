/** Input for the repository analysis agent (§7). */
export interface AnalysisRequest {
  changeRequestId: string;
  key: string;
}

/** Result of a completed analysis. The plan schema arrives with the agent in Phase 3. */
export interface AnalysisOutcome {
  plan: unknown;
  baselineSha: string;
  agent: string;
  model: string;
}

/** Thrown when no analysis agent is available; the job fails visibly instead of faking a plan. */
export class AnalysisAgentNotConfiguredError extends Error {
  constructor() {
    super(
      'Analysis agent not configured: repository analysis arrives in Phase 3 ' +
        '(GitHub App + isolated agent container). No plan was produced.',
    );
    this.name = 'AnalysisAgentNotConfiguredError';
  }
}

export abstract class AnalysisAgent {
  abstract readonly kind: string;
  abstract analyze(request: AnalysisRequest): Promise<AnalysisOutcome>;
}

/** Phase 2 implementation: always reports that it is not configured. */
export class NotConfiguredAnalysisAgent extends AnalysisAgent {
  readonly kind = 'none';

  analyze(): Promise<AnalysisOutcome> {
    return Promise.reject(new AnalysisAgentNotConfiguredError());
  }
}
