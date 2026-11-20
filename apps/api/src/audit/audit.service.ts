import { Injectable } from '@nestjs/common';
import type { Prisma } from '@evolvesales/db';
import type { RequestContext } from '../common/request-context.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  /** Overrides ctx.actorId, e.g. for a login before the request is authenticated. */
  actorId?: string | null;
}

type Db = Prisma.TransactionClient | PrismaService;

/** Writes to the append-only audit_logs table. Pass `tx` to record inside the same transaction. */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry, ctx: RequestContext, tx?: Db): Promise<void> {
    const db = tx ?? this.prisma;
    await db.auditLog.create({
      data: {
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        before: toJson(entry.before),
        after: toJson(entry.after),
        actorId: entry.actorId !== undefined ? entry.actorId : ctx.actorId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        correlationId: ctx.correlationId,
      },
    });
  }
}

function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  // Round-trip drops undefined fields and turns Decimals/Dates into strings.
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
