import { Injectable, Logger } from '@nestjs/common';
import { type PrismaClient, TransitionError, transitionChangeRequest } from '@evolvesales/db';
import {
  type AnalyzeJobData,
  budgetDayStart,
  checkAgentBudget,
  dec,
  implementationPlanSchema,
} from '@evolvesales/shared';
import { GitHubAppService, GitHubNotConfiguredError } from '../github/github-app.service.js';
import { PrismaService } from '../prisma.service.js';
import { AnalysisAgent, type AnalysisOutcome } from './analysis-agent.js';
import { JobLogWriter } from './job-log.writer.js';
import { verifyPlan } from './plan-verifier.js';

export type AnalyzeOutcome = 'skipped' | 'failed' | 'awaiting-approval' | 'clarification-required';

const SYSTEM = { type: 'SYSTEM' } as const;
const CONTEXT = { channel: 'SYSTEM' } as const;

/** A failure with a message meant for the people looking at the request. */
class AnalysisFailure extends Error {
  constructor(
    message: string,
    readonly timedOut = false,
  ) {
    super(message);
    this.name = 'AnalysisFailure';
  }
}

interface Started {
  jobId: string;
  key: string;
  requesterId: string;
}

/**
 * Handles the `cr-analyze` job (§7):
 * SUBMITTED → ANALYZING → (preflight: agent ready, GitHub App, one authorized repository,
 * spend caps) → baseline SHA + read-only token → runner container → schema check →
 * PlanVerifier → plan v(n) → AWAITING_APPROVAL, or CLARIFICATION_REQUIRED when the agent has
 * blocking questions. Any failure ends in FAILED with the reason; a plan is never invented.
 * Idempotent: a job for a request that is no longer SUBMITTED is skipped.
 */
@Injectable()
export class AnalyzeHandler {
  private readonly logger = new Logger(AnalyzeHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly agent: AnalysisAgent,
    private readonly github: GitHubAppService,
  ) {}

  async handle(data: AnalyzeJobData, queueJobId: string | null): Promise<AnalyzeOutcome> {
    const db: PrismaClient = this.prisma;
    let started: Started;
    try {
      started = await db.$transaction(async (tx) => {
        const t = await transitionChangeRequest(tx, {
          changeRequestId: data.changeRequestId,
          to: 'ANALYZING',
          actor: SYSTEM,
          reason: `analyze job started (${data.trigger})`,
          metadata: { queueJobId },
          context: CONTEXT,
        });
        const job = await tx.agentJob.create({
          data: {
            changeRequestId: data.changeRequestId,
            type: 'ANALYZE',
            status: 'RUNNING',
            queueJobId,
            agentKind: this.agent.kind,
            startedAt: new Date(),
          },
        });
        const cr = await tx.changeRequest.findUniqueOrThrow({
          where: { id: data.changeRequestId },
          select: { requesterId: true },
        });
        return { jobId: job.id, key: t.key, requesterId: cr.requesterId };
      });
    } catch (err) {
      if (err instanceof TransitionError) {
        this.logger.warn(`skipping analyze for ${data.changeRequestId}: ${err.message}`);
        return 'skipped';
      }
      throw err;
    }

    const log = new JobLogWriter(db, started.jobId, data.changeRequestId, started.requesterId);
    log.info(`analysis of ${started.key} started (${data.trigger})`);
    try {
      return await this.run(data.changeRequestId, started, log);
    } catch (err) {
      const failure =
        err instanceof AnalysisFailure
          ? err
          : new AnalysisFailure(
              err instanceof GitHubNotConfiguredError
                ? err.message
                : `Analysis failed: ${err instanceof Error ? err.message : String(err)}`,
            );
      log.write('ERROR', 'orchestrator', failure.message);
      await log.close();
      await this.fail(data.changeRequestId, started.jobId, failure);
      return 'failed';
    }
  }

  private async run(crId: string, started: Started, log: JobLogWriter): Promise<AnalyzeOutcome> {
    const db: PrismaClient = this.prisma;

    // ── Preflight: refuse before spending anything. ──
    const notReady = this.agent.notReadyReason();
    if (notReady) throw new AnalysisFailure(notReady);
    if (!this.github.configured) throw new GitHubNotConfiguredError();

    const repos = await db.repository.findMany({ where: { isAuthorized: true, removedAt: null } });
    const repo = repos[0];
    if (!repo || repos.length > 1) {
      throw new AnalysisFailure(
        repos.length === 0
          ? 'No authorized repository: an admin must authorize one on the Repositories page'
          : 'More than one repository is authorized; exactly one is allowed in the MVP',
      );
    }

    const budget = await this.reserveBudget(started.jobId);
    log.info(`budget for this job: ${budget} USD`);

    // ── Baseline and a read-only token for this one repository. ──
    const repoRef = { fullName: repo.fullName, installationId: Number(repo.installationId) };
    const token = await this.github.mintReadToken(repoRef);
    const baselineSha = await this.github.resolveBranchSha(
      token.token,
      repo.fullName,
      repo.defaultBranch,
    );
    log.info(`baseline: ${repo.fullName}@${repo.defaultBranch} = ${baselineSha}`);

    const cr = await db.changeRequest.findUniqueOrThrow({ where: { id: crId } });
    const outcome = await this.agent.analyze({
      jobId: started.jobId,
      changeRequest: {
        key: cr.key,
        title: cr.title,
        originalRequest: cr.originalRequest,
        structured: cr.structured,
        screen: cr.screen,
        screenContext: cr.screenContext,
      },
      repository: {
        fullName: repo.fullName,
        cloneUrl: `${this.github.cloneBaseUrl}/${repo.fullName}.git`,
      },
      baselineSha,
      githubToken: token.token,
      maxBudgetUsd: Number(budget),
      log: (level, source, message) => log.write(level, source, message),
    });
    await this.recordRun(started.jobId, outcome);

    if (!outcome.ok) throw new AnalysisFailure(outcome.error, outcome.timedOut);
    if (outcome.headSha !== baselineSha) {
      throw new AnalysisFailure(
        `The runner analysed ${outcome.headSha}, not the baseline ${baselineSha}; the plan was discarded`,
      );
    }
    const parsed = implementationPlanSchema.safeParse(outcome.plan);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new AnalysisFailure(`The agent's plan does not match the plan schema: ${issues}`);
    }

    // ── PlanVerifier: check every cited excerpt against GitHub at the baseline. ──
    const files = await this.github.listFiles(token.token, repo.fullName, baselineSha);
    const cache = new Map<string, Promise<string | null>>();
    const verified = await verifyPlan(parsed.data, {
      sha: baselineSha,
      hasFile: (p) => files.has(p),
      readFile: (p) => {
        let text = cache.get(p);
        if (!text) {
          text = this.github.readFile(token.token, repo.fullName, p, baselineSha);
          cache.set(p, text);
        }
        return text;
      },
    });
    const downgraded = verified.plan.verification.downgraded.length;
    log.info(
      `plan verified: ${verified.verifiedCount} verified finding(s), ${downgraded} downgraded, ${verified.assumptionCount} assumption(s)`,
    );
    const questions = verified.plan.blockingQuestions;
    await log.close();

    return db.$transaction(async (tx) => {
      const last = await tx.implementationPlan.findFirst({
        where: { changeRequestId: crId },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const plan = await tx.implementationPlan.create({
        data: {
          changeRequestId: crId,
          version: (last?.version ?? 0) + 1,
          baselineSha,
          plan: verified.plan,
          verifiedCount: verified.verifiedCount,
          assumptionCount: verified.assumptionCount,
          agent: outcome.agent,
          model: outcome.model,
        },
      });
      await tx.agentJob.update({
        where: { id: started.jobId },
        data: { status: 'SUCCEEDED', finishedAt: new Date() },
      });
      const toClarify = questions.length > 0;
      await transitionChangeRequest(tx, {
        changeRequestId: crId,
        to: toClarify ? 'CLARIFICATION_REQUIRED' : 'AWAITING_APPROVAL',
        actor: SYSTEM,
        reason: toClarify
          ? `The analysis agent needs answers before planning (${questions.length} question(s))`
          : `Plan v${plan.version} verified (${verified.verifiedCount} verified finding(s))`,
        metadata: { agentJobId: started.jobId, planVersion: plan.version, baselineSha },
        context: CONTEXT,
        data: { baselineSha, ...(toClarify && { pendingQuestions: questions }) },
      });
      // Foreign keys can't go in the guarded updateMany; same transaction, so still atomic.
      await tx.changeRequest.update({
        where: { id: crId },
        data: { currentPlanId: plan.id, repositoryId: repo.id },
      });
      return toClarify ? 'clarification-required' : 'awaiting-approval';
    });
  }

  /**
   * Applies the spend caps (§0: no defaults). In-flight jobs count with their full budget, so
   * parallel jobs can't overshoot the daily cap. Returns this job's budget.
   */
  private async reserveBudget(jobId: string): Promise<string> {
    const db: PrismaClient = this.prisma;
    return db.$transaction(async (tx) => {
      // Serialise budget decisions across workers.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('evolvesales.agent_budget'))`;
      const settings = await tx.agentSettings.findUnique({ where: { id: 1 } });
      const rows = await tx.$queryRaw<Array<{ spent: string | null }>>`
        SELECT COALESCE(SUM(COALESCE(cost_usd, budget_usd)), 0)::text AS spent
        FROM agent_jobs
        WHERE started_at >= ${budgetDayStart(new Date())} AND id <> ${jobId}::uuid`;
      const check = checkAgentBudget({
        perJobCapUsd: settings?.analyzeMaxBudgetUsd?.toString() ?? null,
        dailyCapUsd: settings?.dailyBudgetUsd?.toString() ?? null,
        spentTodayUsd: rows[0]?.spent ?? '0',
      });
      if (!check.ok) throw new AnalysisFailure(check.message);
      await tx.agentJob.update({ where: { id: jobId }, data: { budgetUsd: check.perJobUsd } });
      return check.perJobUsd;
    });
  }

  private async recordRun(jobId: string, outcome: AnalysisOutcome): Promise<void> {
    await this.prisma.agentJob.update({
      where: { id: jobId },
      data: {
        agentKind: outcome.agent,
        model: outcome.model,
        containerId: outcome.containerId,
        imageDigest: outcome.imageDigest,
        inputTokens: outcome.usage?.inputTokens ?? null,
        outputTokens: outcome.usage?.outputTokens ?? null,
        costUsd: outcome.costUsd === null ? null : dec(outcome.costUsd).toFixed(4),
      },
    });
  }

  private async fail(crId: string, jobId: string, failure: AnalysisFailure): Promise<void> {
    const db: PrismaClient = this.prisma;
    const message = failure.message.slice(0, 2000);
    await db.$transaction(async (tx) => {
      await tx.agentJob.update({
        where: { id: jobId },
        data: {
          status: failure.timedOut ? 'TIMED_OUT' : 'FAILED',
          finishedAt: new Date(),
          error: message,
        },
      });
      await transitionChangeRequest(tx, {
        changeRequestId: crId,
        to: 'FAILED',
        actor: SYSTEM,
        reason: message,
        metadata: { agentJobId: jobId },
        context: CONTEXT,
      });
    });
  }
}
