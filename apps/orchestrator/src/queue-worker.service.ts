import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { type AnalyzeJobData, QUEUE, QUEUE_SCHEMA } from '@evolvesales/shared';
import { PgBoss } from 'pg-boss';
import { z } from 'zod';
import { AnalyzeHandler } from './analysis/analyze.handler.js';
import { OrchestratorConfig } from './config.js';

const analyzeJobSchema = z.object({
  changeRequestId: z.uuid(),
  trigger: z.enum(['submitted', 'resubmitted', 'retry']),
});

/** Consumes durable jobs from pg-boss and runs queue maintenance. */
@Injectable()
export class QueueWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueWorkerService.name);
  private readonly boss: PgBoss;

  constructor(
    config: OrchestratorConfig,
    private readonly analyze: AnalyzeHandler,
  ) {
    this.boss = new PgBoss({ connectionString: config.env.DATABASE_URL, schema: QUEUE_SCHEMA });
    this.boss.on('error', (err: unknown) => {
      this.logger.error(`pg-boss error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  async onModuleInit(): Promise<void> {
    await this.boss.start();
    for (const name of Object.values(QUEUE)) {
      if (!(await this.boss.getQueue(name))) {
        await this.boss.createQueue(name, { retryLimit: 0, expireInSeconds: 30 * 60 });
      }
    }
    await this.boss.work<AnalyzeJobData>(QUEUE.Analyze, async (jobs) => {
      for (const job of jobs) {
        const parsed = analyzeJobSchema.safeParse(job.data);
        if (!parsed.success) {
          this.logger.error(`discarding malformed ${QUEUE.Analyze} job ${job.id}`);
          continue;
        }
        const outcome = await this.analyze.handle(parsed.data, job.id);
        this.logger.log(`${QUEUE.Analyze} ${job.id}: ${outcome}`);
      }
    });
    this.logger.log(`consuming ${QUEUE.Analyze}`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.boss.stop({ graceful: true, timeout: 10_000 });
  }
}
