import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  type AgentSettingsDto,
  budgetDayStart,
  type JobLogPageDto,
  type JobLogQuery,
  money,
  type RepositoryDto,
  type UpdateAgentSettingsInput,
} from '@evolvesales/shared';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { canView } from '../change-requests/change-request-policy.js';
import type { RequestContext } from '../common/request-context.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { QueueService } from '../queue/queue.service.js';

const person = { select: { id: true, displayName: true } } as const;

/**
 * Admin settings for the agents (§0 spend caps, §11 repository authorization) and the job log
 * read model for the Execution Monitor. The API holds no GitHub credentials: the repository
 * list is synced by the Orchestrator; "Refresh" only enqueues that sync.
 */
@Injectable()
export class AgentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queue: QueueService,
  ) {}

  async getSettings(now: Date = new Date()): Promise<AgentSettingsDto> {
    const [settings, spent] = await Promise.all([
      this.prisma.agentSettings.findUnique({ where: { id: 1 }, include: { updatedBy: person } }),
      this.prisma.agentJob.aggregate({
        where: { startedAt: { gte: budgetDayStart(now) } },
        _sum: { costUsd: true },
      }),
    ]);
    return {
      analyzeMaxBudgetUsd: settings?.analyzeMaxBudgetUsd
        ? money(settings.analyzeMaxBudgetUsd.toString())
        : null,
      dailyBudgetUsd: settings?.dailyBudgetUsd ? money(settings.dailyBudgetUsd.toString()) : null,
      spentTodayUsd: money(spent._sum.costUsd?.toString() ?? '0'),
      updatedAt: settings?.updatedAt.toISOString() ?? null,
      updatedBy: settings?.updatedBy ?? null,
    };
  }

  async updateSettings(
    input: UpdateAgentSettingsInput,
    user: AuthUser,
    ctx: RequestContext,
  ): Promise<AgentSettingsDto> {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.agentSettings.findUnique({ where: { id: 1 } });
      await tx.agentSettings.upsert({
        where: { id: 1 },
        create: { id: 1, ...input, updatedById: user.id },
        update: { ...input, updatedById: user.id },
      });
      await this.audit.record(
        {
          action: 'agent_settings.updated',
          entityType: 'AgentSettings',
          entityId: '1',
          before: before && {
            analyzeMaxBudgetUsd: before.analyzeMaxBudgetUsd?.toString() ?? null,
            dailyBudgetUsd: before.dailyBudgetUsd?.toString() ?? null,
          },
          after: input,
        },
        ctx,
        tx,
      );
    });
    return this.getSettings();
  }

  async listRepositories(): Promise<RepositoryDto[]> {
    const rows = await this.prisma.repository.findMany({
      orderBy: [{ removedAt: { sort: 'desc', nulls: 'first' } }, { fullName: 'asc' }],
      include: { authorizedBy: person },
    });
    return rows.map(toRepositoryDto);
  }

  /** Exactly one repository may be authorized in the MVP; removed ones can't be. */
  async setAuthorization(
    id: string,
    authorized: boolean,
    user: AuthUser,
    ctx: RequestContext,
  ): Promise<RepositoryDto> {
    await this.prisma.$transaction(async (tx) => {
      const repo = await tx.repository.findUnique({ where: { id } });
      if (!repo) throw new NotFoundException('Repository not found');
      if (repo.isAuthorized === authorized) return;
      if (authorized) {
        if (repo.removedAt) {
          throw new ConflictException('The GitHub App no longer has access to this repository');
        }
        const other = await tx.repository.findFirst({
          where: { isAuthorized: true, id: { not: id } },
        });
        if (other) {
          throw new ConflictException(
            `${other.fullName} is already authorized; revoke it first (one repository at a time)`,
          );
        }
      }
      // Guarded update: concurrent toggles can't both succeed.
      const updated = await tx.repository.updateMany({
        where: { id, isAuthorized: !authorized },
        data: authorized
          ? { isAuthorized: true, authorizedById: user.id, authorizedAt: new Date() }
          : { isAuthorized: false, authorizedById: null, authorizedAt: null },
      });
      if (updated.count !== 1)
        throw new ConflictException('The repository changed meanwhile; reload');
      await this.audit.record(
        {
          action: authorized ? 'repository.authorized' : 'repository.deauthorized',
          entityType: 'Repository',
          entityId: id,
          after: { fullName: repo.fullName },
        },
        ctx,
        tx,
      );
    });
    const row = await this.prisma.repository.findUniqueOrThrow({
      where: { id },
      include: { authorizedBy: person },
    });
    return toRepositoryDto(row);
  }

  async requestSync(user: AuthUser, ctx: RequestContext): Promise<{ queued: true }> {
    await this.prisma.$transaction(async (tx) => {
      await this.queue.enqueueRepoSync(tx, { requestedById: user.id });
      await this.audit.record(
        { action: 'repository.sync_requested', entityType: 'Repository' },
        ctx,
        tx,
      );
    });
    return { queued: true };
  }

  /** Job log lines after `after`; same visibility as the change request itself. */
  async jobLogs(
    crId: string,
    jobId: string,
    q: JobLogQuery,
    user: AuthUser,
  ): Promise<JobLogPageDto> {
    const job = await this.prisma.agentJob.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        status: true,
        changeRequestId: true,
        changeRequest: { select: { requesterId: true } },
      },
    });
    if (!job || job.changeRequestId !== crId || !canView(user, job.changeRequest)) {
      throw new NotFoundException('Job not found');
    }
    const lines = await this.prisma.jobLog.findMany({
      where: { agentJobId: jobId, seq: { gt: q.after } },
      orderBy: { seq: 'asc' },
      take: q.limit,
    });
    return {
      jobId,
      status: job.status,
      lines: lines.map((l) => ({
        seq: l.seq,
        level: l.level,
        source: l.source,
        message: l.message,
        createdAt: l.createdAt.toISOString(),
      })),
      lastSeq: lines.at(-1)?.seq ?? q.after,
    };
  }
}

type RepoRow = {
  id: string;
  fullName: string;
  defaultBranch: string;
  isPrivate: boolean;
  isAuthorized: boolean;
  authorizedAt: Date | null;
  removedAt: Date | null;
  lastSyncedAt: Date;
  authorizedBy: { id: string; displayName: string } | null;
};

function toRepositoryDto(r: RepoRow): RepositoryDto {
  return {
    id: r.id,
    fullName: r.fullName,
    defaultBranch: r.defaultBranch,
    isPrivate: r.isPrivate,
    isAuthorized: r.isAuthorized,
    authorizedBy: r.authorizedBy,
    authorizedAt: r.authorizedAt?.toISOString() ?? null,
    removedAt: r.removedAt?.toISOString() ?? null,
    lastSyncedAt: r.lastSyncedAt.toISOString(),
  };
}
