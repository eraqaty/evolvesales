import { Injectable, Logger } from '@nestjs/common';
import { type PrismaClient, TransitionError, transitionChangeRequest } from '@evolvesales/db';
import type { AnalyzeJobData } from '@evolvesales/shared';
import { PrismaService } from '../prisma.service.js';
import { AnalysisAgent } from './analysis-agent.js';

export type AnalyzeOutcome = 'skipped' | 'failed' | 'awaiting-approval';

const SYSTEM = { type: 'SYSTEM' } as const;
const CONTEXT = { channel: 'SYSTEM' } as const;

/**
 * Handles the `cr-analyze` job (§7): SUBMITTED → ANALYZING, run the analysis agent, then store
 * the plan and move to AWAITING_APPROVAL, or record the failure and move to FAILED.
 * Idempotent: a job for a request that is no longer SUBMITTED is skipped.
 */
@Injectable()
export class AnalyzeHandler {
  private readonly logger = new Logger(AnalyzeHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly agent: AnalysisAgent,
  ) {}

  async handle(data: AnalyzeJobData, queueJobId: string | null): Promise<AnalyzeOutcome> {
    const db: PrismaClient = this.prisma;
    let started: { jobId: string; key: string };
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
        return { jobId: job.id, key: t.key };
      });
    } catch (err) {
      if (err instanceof TransitionError) {
        this.logger.warn(`skipping analyze for ${data.changeRequestId}: ${err.message}`);
        return 'skipped';
      }
      throw err;
    }

    try {
      const outcome = await this.agent.analyze({
        changeRequestId: data.changeRequestId,
        key: started.key,
      });
      // Phase 3 stores and verifies the plan here before AWAITING_APPROVAL.
      void outcome;
      throw new Error('Plan storage is not implemented before Phase 3');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await db.$transaction(async (tx) => {
        await tx.agentJob.update({
          where: { id: started.jobId },
          data: { status: 'FAILED', finishedAt: new Date(), error: message },
        });
        await transitionChangeRequest(tx, {
          changeRequestId: data.changeRequestId,
          to: 'FAILED',
          actor: SYSTEM,
          reason: message,
          metadata: { agentJobId: started.jobId },
          context: CONTEXT,
        });
      });
      this.logger.warn(`analysis failed for ${started.key}: ${message}`);
      return 'failed';
    }
  }
}
