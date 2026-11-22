import { Injectable } from '@nestjs/common';
import { RUNNER_PROTOCOL_VERSION, type RunnerStdin } from '@evolvesales/shared';
import { DockerLauncher } from '../agent/docker-launcher.js';
import { OrchestratorConfig } from '../config.js';
import { AnalysisAgent, type AnalysisOutcome, type AnalysisRequest } from './analysis-agent.js';

const LEVEL = { info: 'INFO', warn: 'WARN', error: 'ERROR' } as const;

/**
 * Claude Agent SDK analysis inside a single-use agent-runner container (§7, §9).
 * The container gets the read-only GitHub token and the AI key on stdin only, joins the
 * internal agent network (egress proxy only), and is removed afterwards.
 */
@Injectable()
export class ContainerAnalysisAgent extends AnalysisAgent {
  readonly kind = 'claude-agent-sdk';

  constructor(
    private readonly config: OrchestratorConfig,
    private readonly launcher: DockerLauncher,
  ) {
    super();
  }

  notReadyReason(): string | null {
    const runtime = this.config.agentRuntime;
    return 'missing' in runtime ? `Analysis agent not configured: ${runtime.missing}` : null;
  }

  async analyze(req: AnalysisRequest): Promise<AnalysisOutcome> {
    const runtime = this.config.agentRuntime;
    if ('missing' in runtime) throw new Error(`Analysis agent not configured: ${runtime.missing}`);

    const payload: RunnerStdin = {
      input: {
        protocol: RUNNER_PROTOCOL_VERSION,
        mode: 'analyze',
        jobId: req.jobId,
        repository: req.repository,
        baselineSha: req.baselineSha,
        changeRequest: req.changeRequest,
        limits: { maxTurns: runtime.maxTurns, maxBudgetUsd: req.maxBudgetUsd },
        model: runtime.model,
      },
      secrets: { githubToken: req.githubToken, anthropicApiKey: runtime.anthropicApiKey },
    };

    req.log('INFO', 'orchestrator', `starting runner container (${runtime.image})`);
    const run = await this.launcher.run({
      jobId: req.jobId,
      image: runtime.image,
      stdin: JSON.stringify(payload),
      timeoutMs: runtime.timeoutMs,
      network: runtime.network,
      env: {
        HTTPS_PROXY: runtime.egressProxyUrl,
        HTTP_PROXY: runtime.egressProxyUrl,
        https_proxy: runtime.egressProxyUrl,
        http_proxy: runtime.egressProxyUrl,
        NO_PROXY: '',
      },
      onEvent: (e) => {
        if (e.type === 'log') req.log(LEVEL[e.level], e.source, e.message);
      },
      onText: (line, stream) => req.log(stream === 'stderr' ? 'WARN' : 'INFO', 'runner', line),
    });
    req.log(
      run.removed ? 'INFO' : 'ERROR',
      'orchestrator',
      run.removed
        ? `runner container ${run.containerId.slice(0, 12)} exited (code ${run.exitCode ?? 'none'}) and was removed`
        : `runner container ${run.containerId.slice(0, 12)} could NOT be confirmed removed`,
    );

    const common = {
      agent: this.kind,
      containerId: run.containerId,
      imageDigest: run.imageDigest,
    };
    if (run.timedOut) {
      return {
        ...common,
        ok: false,
        timedOut: true,
        error: `Analysis timed out after ${Math.round(runtime.timeoutMs / 60_000)} minutes`,
        model: runtime.model,
        usage: null,
        costUsd: null,
      };
    }
    const r = run.result;
    if (run.outputLimitHit || !r) {
      return {
        ...common,
        ok: false,
        timedOut: false,
        error: run.outputLimitHit
          ? 'The runner produced too much output and was stopped'
          : `The runner exited (code ${run.exitCode ?? 'none'}) without a result`,
        model: runtime.model,
        usage: null,
        costUsd: null,
      };
    }
    if (!r.ok) {
      return {
        ...common,
        ok: false,
        timedOut: false,
        error: r.error,
        model: runtime.model,
        usage: r.usage ?? null,
        costUsd: r.costUsd ?? null,
      };
    }
    return {
      ...common,
      ok: true,
      plan: r.plan,
      headSha: r.headSha,
      numTurns: r.numTurns,
      model: r.model,
      usage: r.usage,
      costUsd: r.costUsd,
    };
  }
}
