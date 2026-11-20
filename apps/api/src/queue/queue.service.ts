import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@evolvesales/db';
import { type AnalyzeJobData, QUEUE, QUEUE_SCHEMA } from '@evolvesales/shared';
import { fromPrisma, PgBoss } from 'pg-boss';
import { AppConfig } from '../config/app-config.js';

/**
 * Publishes durable jobs to pg-boss (same Postgres, `pgboss` schema). The API only publishes;
 * the Orchestrator consumes. Jobs are sent inside the caller's Prisma transaction, so a job
 * exists if and only if the status change that requires it was committed.
 */
@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private readonly boss: PgBoss;

  constructor(config: AppConfig) {
    this.boss = new PgBoss({
      connectionString: config.env.DATABASE_URL,
      schema: QUEUE_SCHEMA,
      // The API never runs maintenance or schedules; the Orchestrator does.
      supervise: false,
      schedule: false,
    });
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
  }

  async onModuleDestroy(): Promise<void> {
    await this.boss.stop({ graceful: true, timeout: 5_000 });
  }

  /** Enqueue repository analysis for a change request, atomically with `tx`. */
  async enqueueAnalyze(tx: Prisma.TransactionClient, data: AnalyzeJobData): Promise<string | null> {
    return this.boss.send(QUEUE.Analyze, { ...data }, { db: fromPrisma(tx) });
  }
}
