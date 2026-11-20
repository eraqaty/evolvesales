import {
  type Actor,
  checkTransition,
  CR_STATUS_LABELS,
  type CrStatus,
  formatCrKey,
  REALTIME_CHANNEL,
  type RealtimeEvent,
  Role,
  type TransitionErrorCode,
} from '@evolvesales/shared';
import type { Prisma } from './generated/client.js';

type Tx = Prisma.TransactionClient;

/** A rejected transition. `conflict` means the request changed underneath us (stale status). */
export class TransitionError extends Error {
  constructor(
    readonly code: TransitionErrorCode | 'not_found' | 'conflict',
    message: string,
  ) {
    super(message);
    this.name = 'TransitionError';
  }
}

/** Who acted; for users, whether they are the requester is derived from the request itself. */
export type ActorInput = { type: 'SYSTEM' } | { type: 'USER'; userId: string; roles: Role[] };

export interface TransitionAuditContext {
  ip?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
  channel?: 'WEB' | 'WHATSAPP' | 'SYSTEM';
}

export interface TransitionInput {
  changeRequestId: string;
  to: CrStatus;
  actor: ActorInput;
  reason?: string | null;
  metadata?: Record<string, unknown>;
  context?: TransitionAuditContext;
  /** Extra columns to change in the same guarded UPDATE. */
  data?: Prisma.ChangeRequestUpdateManyMutationInput;
}

export interface TransitionResult {
  id: string;
  key: string;
  from: CrStatus | null;
  to: CrStatus;
}

interface CrRow {
  id: string;
  key: string;
  title: string;
  status: CrStatus;
  requesterId: string;
}

/** Allocates the next human-readable key (CR-0001). */
export async function allocateCrKey(tx: Tx): Promise<string> {
  const rows = await tx.$queryRaw<
    Array<{ seq: bigint }>
  >`SELECT nextval('change_request_key_seq') AS seq`;
  const seq = rows[0]?.seq;
  if (seq === undefined) throw new Error('change_request_key_seq returned no value');
  return formatCrKey(Number(seq));
}

export function toSharedActor(actor: ActorInput, requesterId: string): Actor {
  return actor.type === 'SYSTEM'
    ? actor
    : {
        type: 'USER',
        userId: actor.userId,
        roles: actor.roles,
        isRequester: actor.userId === requesterId,
      };
}

/**
 * The only way a change request's status changes (§5). Must run inside a transaction:
 * 1. checks the rule and the actor, 2. guarded UPDATE … WHERE status = from,
 * 3. StatusTransition + AuditLog rows, 4. notifications, 5. NOTIFY (delivered on commit).
 */
export async function transitionChangeRequest(
  tx: Tx,
  input: TransitionInput,
): Promise<TransitionResult> {
  const cr = await tx.changeRequest.findUnique({
    where: { id: input.changeRequestId },
    select: { id: true, key: true, title: true, status: true, requesterId: true },
  });
  if (!cr) throw new TransitionError('not_found', 'Change request not found');

  const check = checkTransition(
    cr.status,
    input.to,
    toSharedActor(input.actor, cr.requesterId),
    input.reason,
  );
  if (!check.ok) throw new TransitionError(check.code, check.reason);

  const updated = await tx.changeRequest.updateMany({
    where: { id: cr.id, status: cr.status },
    data: { ...input.data, status: input.to },
  });
  if (updated.count !== 1) {
    throw new TransitionError('conflict', 'The request changed meanwhile; reload and try again');
  }

  await recordTransition(tx, cr, cr.status, input);
  return { id: cr.id, key: cr.key, from: cr.status, to: input.to };
}

/**
 * Writes history, audit, notifications and the realtime event for a transition that has
 * already been applied (also used for the initial ∅ → SUBMITTED on creation).
 */
export async function recordTransition(
  tx: Tx,
  cr: CrRow,
  from: CrStatus | null,
  input: Omit<TransitionInput, 'changeRequestId' | 'data'>,
): Promise<void> {
  const actorId = input.actor.type === 'USER' ? input.actor.userId : null;
  const reason = input.reason?.trim() || null;
  const metadata = {
    ...input.metadata,
    ...(input.context?.channel && { channel: input.context.channel }),
  };

  await tx.statusTransition.create({
    data: {
      changeRequestId: cr.id,
      from,
      to: input.to,
      actorType: input.actor.type,
      actorId,
      reason,
      metadata,
    },
  });

  await tx.auditLog.create({
    data: {
      actorId,
      action: 'change_request.transition',
      entityType: 'ChangeRequest',
      entityId: cr.id,
      before: from ? { status: from } : undefined,
      after: { status: input.to, reason, key: cr.key, ...metadata },
      ip: input.context?.ip ?? null,
      userAgent: input.context?.userAgent ?? null,
      correlationId: input.context?.correlationId ?? null,
    },
  });

  const recipients = await notificationRecipients(tx, cr, input.to, actorId);
  const label = CR_STATUS_LABELS[input.to];
  const link = `/requests/${cr.id}`;
  if (recipients.length > 0) {
    await tx.notification.createMany({
      data: recipients.map((r) => ({
        userId: r.userId,
        type: r.type,
        title:
          r.type === 'cr.awaiting_approval'
            ? `${cr.key} needs your approval`
            : `${cr.key}: ${label}`,
        body: reason ? `${cr.title} — ${reason}` : cr.title,
        link,
      })),
    });
  }

  const event: RealtimeEvent = {
    type: 'cr.updated',
    changeRequestId: cr.id,
    status: input.to,
    userIds: [...new Set([cr.requesterId, ...recipients.map((r) => r.userId)])],
    roles: [Role.ChangeApprover, Role.ReleaseManager, Role.Admin],
  };
  await tx.$executeRaw`SELECT pg_notify(${REALTIME_CHANNEL}, ${JSON.stringify(event)})`;
}

async function notificationRecipients(
  tx: Tx,
  cr: CrRow,
  to: CrStatus,
  actorId: string | null,
): Promise<Array<{ userId: string; type: string }>> {
  const out: Array<{ userId: string; type: string }> = [];
  if (cr.requesterId !== actorId) {
    out.push({
      userId: cr.requesterId,
      type: to === 'CLARIFICATION_REQUIRED' ? 'cr.clarification_needed' : 'cr.status_changed',
    });
  }
  if (to === 'AWAITING_APPROVAL') {
    const approvers = await tx.user.findMany({
      where: {
        isActive: true,
        roles: { hasSome: [Role.ChangeApprover, Role.Admin] },
        id: { notIn: [cr.requesterId, ...(actorId ? [actorId] : [])] },
      },
      select: { id: true },
    });
    out.push(...approvers.map((a) => ({ userId: a.id, type: 'cr.awaiting_approval' })));
  }
  return out;
}
