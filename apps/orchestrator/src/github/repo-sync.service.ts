import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { REALTIME_CHANNEL, type RealtimeEvent, Role } from '@evolvesales/shared';
import { OrchestratorConfig } from '../config.js';
import { PrismaService } from '../prisma.service.js';
import { GitHubAppService } from './github-app.service.js';

export interface RepoSyncResult {
  seen: number;
  removed: number;
}

/**
 * Mirrors the GitHub App's installation repositories into `repositories` (§11), so the API's
 * admin page can list them without holding GitHub credentials. Runs at start-up, every
 * REPO_SYNC_INTERVAL_MINUTES, and when an admin presses "Refresh" (queue `github-repo-sync`).
 * A repository the App can no longer see is marked removed and loses its authorization.
 */
@Injectable()
export class RepoSyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RepoSyncService.name);
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<RepoSyncResult> | null = null;

  constructor(
    private readonly config: OrchestratorConfig,
    private readonly prisma: PrismaService,
    private readonly github: GitHubAppService,
  ) {}

  onModuleInit(): void {
    if (!this.github.configured || this.config.env.NODE_ENV === 'test') return;
    void this.syncQuietly();
    this.timer = setInterval(
      () => void this.syncQuietly(),
      this.config.env.REPO_SYNC_INTERVAL_MINUTES * 60_000,
    );
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One sync at a time; concurrent callers share the running one. */
  sync(requestedById: string | null = null): Promise<RepoSyncResult> {
    this.running ??= this.doSync(requestedById).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async syncQuietly(): Promise<void> {
    try {
      const r = await this.sync();
      this.logger.log(`repository sync: ${r.seen} visible, ${r.removed} removed`);
    } catch (err) {
      this.logger.warn(
        `repository sync failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async doSync(requestedById: string | null): Promise<RepoSyncResult> {
    const repos = await this.github.listInstallationRepositories();
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      for (const r of repos) {
        await tx.repository.upsert({
          where: { githubId: BigInt(r.githubId) },
          create: {
            githubId: BigInt(r.githubId),
            fullName: r.fullName,
            installationId: BigInt(r.installationId),
            defaultBranch: r.defaultBranch,
            isPrivate: r.isPrivate,
            lastSyncedAt: now,
          },
          update: {
            fullName: r.fullName,
            installationId: BigInt(r.installationId),
            defaultBranch: r.defaultBranch,
            isPrivate: r.isPrivate,
            removedAt: null,
            lastSyncedAt: now,
          },
        });
      }
      const gone = await tx.repository.findMany({
        where: {
          githubId: { notIn: repos.map((r) => BigInt(r.githubId)) },
          removedAt: null,
        },
        select: { id: true, fullName: true, isAuthorized: true },
      });
      for (const g of gone) {
        await tx.repository.update({
          where: { id: g.id },
          data: { removedAt: now, isAuthorized: false, lastSyncedAt: now },
        });
        if (g.isAuthorized) {
          await tx.auditLog.create({
            data: {
              actorId: null,
              action: 'repository.deauthorized',
              entityType: 'Repository',
              entityId: g.id,
              after: { fullName: g.fullName, reason: 'GitHub App lost access' },
            },
          });
        }
      }
      await tx.auditLog.create({
        data: {
          actorId: requestedById,
          action: 'repository.synced',
          entityType: 'Repository',
          entityId: null,
          after: { seen: repos.length, removed: gone.length },
        },
      });
      const event: RealtimeEvent = { type: 'repos.updated', userIds: [], roles: [Role.Admin] };
      await tx.$executeRaw`SELECT pg_notify(${REALTIME_CHANNEL}, ${JSON.stringify(event)})`;
      return { seen: repos.length, removed: gone.length };
    });
  }
}
