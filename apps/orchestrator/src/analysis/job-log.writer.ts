import { Logger } from '@nestjs/common';
import type { PrismaClient } from '@evolvesales/db';
import { REALTIME_CHANNEL, type RealtimeEvent, redactSecrets, Role } from '@evolvesales/shared';

export type LogLevel = 'INFO' | 'WARN' | 'ERROR';
export type LogSource = 'orchestrator' | 'runner' | 'agent';

const MAX_LINE = 4000;
const MAX_LINES_PER_JOB = 5000;
const FLUSH_MS = 500;

/**
 * Buffers one job's log lines and writes them in small batches (§13 Execution Monitor).
 * Every line is redacted for credential-shaped text before it is stored. After each batch a
 * `job.log` NOTIFY tells browsers to re-fetch through the authorised REST API.
 */
export class JobLogWriter {
  private readonly logger = new Logger(JobLogWriter.name);
  private seq = 0;
  private buffer: Array<{ seq: number; level: LogLevel; source: LogSource; message: string }> = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> = Promise.resolve();
  private dropped = 0;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly jobId: string,
    private readonly changeRequestId: string,
    private readonly requesterId: string,
  ) {}

  write(level: LogLevel, source: LogSource, message: string): void {
    if (this.seq >= MAX_LINES_PER_JOB) {
      this.dropped += 1;
      return;
    }
    const clean = redactSecrets(message).slice(0, MAX_LINE);
    this.buffer.push({ seq: this.seq++, level, source, message: clean });
    this.timer ??= setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, FLUSH_MS);
  }

  info(message: string): void {
    this.write('INFO', 'orchestrator', message);
  }

  /** Writes everything still buffered; call before the job's final status change. */
  async close(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.dropped > 0) {
      this.buffer.push({
        seq: this.seq++,
        level: 'WARN',
        source: 'orchestrator',
        message: `${this.dropped} further log lines were dropped (limit ${MAX_LINES_PER_JOB} per job)`,
      });
      this.dropped = 0;
    }
    await this.flush();
  }

  private flush(): Promise<void> {
    this.flushing = this.flushing.then(async () => {
      const batch = this.buffer;
      this.buffer = [];
      if (batch.length === 0) return;
      try {
        await this.prisma.jobLog.createMany({
          data: batch.map((l) => ({ agentJobId: this.jobId, ...l })),
          skipDuplicates: true,
        });
        const event: RealtimeEvent = {
          type: 'job.log',
          changeRequestId: this.changeRequestId,
          jobId: this.jobId,
          userIds: [this.requesterId],
          roles: [Role.ChangeApprover, Role.ReleaseManager, Role.Admin],
        };
        await this.prisma
          .$executeRaw`SELECT pg_notify(${REALTIME_CHANNEL}, ${JSON.stringify(event)})`;
      } catch (err) {
        this.logger.warn(
          `could not store ${batch.length} log line(s) for job ${this.jobId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
    return this.flushing;
  }
}
