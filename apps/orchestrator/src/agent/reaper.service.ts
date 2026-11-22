import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { TransitionError, transitionChangeRequest } from '@evolvesales/db';
import { OrchestratorConfig } from '../config.js';
import { PrismaService } from '../prisma.service.js';
import { DockerLauncher } from './docker-launcher.js';

const REASON = 'The Orchestrator restarted while this job was running; the job was stopped.';

/**
 * Start-up cleanup (§9): removes runner containers left by a crash and fails the jobs that
 * were running in them. Assumes one Orchestrator instance (the MVP topology).
 */
@Injectable()
export class ReaperService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReaperService.name);

  constructor(
    private readonly config: OrchestratorConfig,
    private readonly prisma: PrismaService,
    private readonly launcher: DockerLauncher,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.env.NODE_ENV === 'test') return;
    await this.reap();
  }

  async reap(bootedAt: Date = new Date()): Promise<{ containers: number; jobs: number }> {
    let containers = 0;
    if (!('missing' in this.config.agentRuntime)) {
      try {
        containers = (await this.launcher.reapOrphans()).length;
      } catch (err) {
        this.logger.warn(
          `could not list runner containers: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const stale = await this.prisma.agentJob.findMany({
      where: { status: 'RUNNING', startedAt: { lt: bootedAt } },
      select: { id: true, changeRequestId: true },
    });
    for (const job of stale) {
      await this.prisma.$transaction(async (tx) => {
        await tx.agentJob.update({
          where: { id: job.id },
          data: { status: 'FAILED', finishedAt: new Date(), error: REASON },
        });
        try {
          await transitionChangeRequest(tx, {
            changeRequestId: job.changeRequestId,
            to: 'FAILED',
            actor: { type: 'SYSTEM' },
            reason: REASON,
            metadata: { agentJobId: job.id },
            context: { channel: 'SYSTEM' },
          });
        } catch (err) {
          if (!(err instanceof TransitionError)) throw err;
        }
      });
    }
    if (containers > 0 || stale.length > 0) {
      this.logger.warn(`reaped ${containers} container(s) and ${stale.length} stale job(s)`);
    }
    return { containers, jobs: stale.length };
  }
}
