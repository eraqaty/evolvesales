import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  type ActorInput,
  allocateCrKey,
  type Prisma,
  recordTransition,
  type TransitionAuditContext,
  transitionChangeRequest,
} from '@evolvesales/db';
import {
  type ApproveInput,
  type ChangeRequestDetailDto,
  type ChangeRequestProposal,
  type ChangeRequestSummaryDto,
  checkTransition,
  type ClarifyRequestInput,
  type ListChangeRequestsQuery,
  type Page,
  type RejectInput,
  type RetryInput,
  type ScreenContext,
} from '@evolvesales/shared';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import type { RequestContext } from '../common/request-context.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { QueueService } from '../queue/queue.service.js';
import {
  crDetailInclude,
  crSummaryInclude,
  toCrDetailDto,
  toCrSummaryDto,
} from './change-request.mapper.js';
import { allowedActions, canView, canViewAll, selfApproval } from './change-request-policy.js';
import { withHttpErrors } from './transition-error.js';

type Tx = Prisma.TransactionClient;

export const userActor = (user: AuthUser): ActorInput => ({
  type: 'USER',
  userId: user.id,
  roles: user.roles,
});

export const auditContext = (ctx: RequestContext): TransitionAuditContext => ({
  ip: ctx.ip,
  userAgent: ctx.userAgent,
  correlationId: ctx.correlationId,
  channel: 'WEB',
});

export interface SubmitInput {
  proposal: ChangeRequestProposal;
  originalRequest: string;
  screenContext: ScreenContext | null;
}

@Injectable()
export class ChangeRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
  ) {}

  async list(q: ListChangeRequestsQuery, user: AuthUser): Promise<Page<ChangeRequestSummaryDto>> {
    const onlyMine = q.mine === true || !canViewAll(user);
    const where: Prisma.ChangeRequestWhereInput = {
      ...(onlyMine && { requesterId: user.id }),
      ...(q.status && { status: q.status }),
      ...(q.search && {
        OR: [
          { key: { contains: q.search, mode: 'insensitive' } },
          { title: { contains: q.search, mode: 'insensitive' } },
        ],
      }),
    };
    const [total, rows] = await Promise.all([
      this.prisma.changeRequest.count({ where }),
      this.prisma.changeRequest.findMany({
        where,
        include: crSummaryInclude,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    return { items: rows.map(toCrSummaryDto), total, page: q.page, pageSize: q.pageSize };
  }

  async get(id: string, user: AuthUser): Promise<ChangeRequestDetailDto> {
    const cr = await this.prisma.changeRequest.findUnique({
      where: { id },
      include: crDetailInclude,
    });
    // Same 404 for "missing" and "not yours", so ids can't be probed.
    if (!cr || !canView(user, cr)) throw new NotFoundException('Change request not found');
    return toCrDetailDto(cr, allowedActions(user, cr));
  }

  /** ∅ → SUBMITTED: creates the request from a validated proposal and enqueues analysis. */
  async create(tx: Tx, input: SubmitInput, user: AuthUser, ctx: RequestContext) {
    const actor = userActor(user);
    const check = checkTransition(null, 'SUBMITTED', {
      type: 'USER',
      userId: user.id,
      roles: user.roles,
      isRequester: true,
    });
    if (!check.ok) throw new ForbiddenException(check.reason);

    const cr = await tx.changeRequest.create({
      data: {
        key: await allocateCrKey(tx),
        title: input.proposal.title,
        requesterId: user.id,
        screen: input.proposal.screen,
        screenContext: input.screenContext ?? undefined,
        originalRequest: input.originalRequest,
        structured: input.proposal,
        priority: input.proposal.priority,
        status: 'SUBMITTED',
      },
    });
    await recordTransition(tx, cr, null, {
      to: 'SUBMITTED',
      actor,
      context: auditContext(ctx),
    });
    await this.queue.enqueueAnalyze(tx, { changeRequestId: cr.id, trigger: 'submitted' });
    return cr;
  }

  /** CLARIFICATION_REQUIRED → SUBMITTED with the requester's updated proposal; re-analysis. */
  async resubmit(
    tx: Tx,
    changeRequestId: string,
    input: SubmitInput,
    user: AuthUser,
    ctx: RequestContext,
  ) {
    const result = await withHttpErrors(() =>
      transitionChangeRequest(tx, {
        changeRequestId,
        to: 'SUBMITTED',
        actor: userActor(user),
        reason: 'Requester answered the clarification questions',
        context: auditContext(ctx),
        data: {
          title: input.proposal.title,
          structured: input.proposal,
          priority: input.proposal.priority,
          pendingQuestions: [],
        },
      }),
    );
    await this.queue.enqueueAnalyze(tx, { changeRequestId, trigger: 'resubmitted' });
    return result;
  }

  async approve(
    id: string,
    input: ApproveInput,
    user: AuthUser,
    ctx: RequestContext,
  ): Promise<ChangeRequestDetailDto> {
    await withHttpErrors(() =>
      this.prisma.$transaction(async (tx) => {
        const cr = await this.loadVisible(tx, id, user);
        const self = selfApproval(user, cr);
        if (self === 'blocked') {
          throw new ForbiddenException('You cannot approve your own change request');
        }
        const overrideReason = input.overrideReason?.trim() || null;
        if (self === 'admin-override-required' && !overrideReason) {
          throw new UnprocessableEntityException(
            'Approving your own request needs an override reason (it is audited)',
          );
        }

        await transitionChangeRequest(tx, {
          changeRequestId: id,
          to: 'APPROVED',
          actor: userActor(user),
          reason: input.comment || null,
          metadata: { planId: cr.currentPlanId, ...(overrideReason && { overrideReason }) },
          context: auditContext(ctx),
        });
        await tx.approvalDecision.create({
          data: {
            changeRequestId: id,
            planId: cr.currentPlanId,
            decision: 'APPROVED',
            actorId: user.id,
            comment: input.comment || null,
            overrideReason: self === 'admin-override-required' ? overrideReason : null,
          },
        });
        if (self === 'admin-override-required') {
          await this.audit.record(
            {
              action: 'change_request.self_approval_override',
              entityType: 'ChangeRequest',
              entityId: id,
              after: { overrideReason },
            },
            ctx,
            tx,
          );
        }
      }),
    );
    // Approval authorizes coding only; the code job arrives with the Coding Agent (Phase 4).
    return this.get(id, user);
  }

  async reject(
    id: string,
    input: RejectInput,
    user: AuthUser,
    ctx: RequestContext,
  ): Promise<ChangeRequestDetailDto> {
    await withHttpErrors(() =>
      this.prisma.$transaction(async (tx) => {
        const cr = await this.loadVisible(tx, id, user);
        await transitionChangeRequest(tx, {
          changeRequestId: id,
          to: 'REJECTED',
          actor: userActor(user),
          reason: input.comment,
          context: auditContext(ctx),
        });
        await tx.approvalDecision.create({
          data: {
            changeRequestId: id,
            planId: cr.currentPlanId,
            decision: 'REJECTED',
            actorId: user.id,
            comment: input.comment,
          },
        });
      }),
    );
    return this.get(id, user);
  }

  async clarify(
    id: string,
    input: ClarifyRequestInput,
    user: AuthUser,
    ctx: RequestContext,
  ): Promise<ChangeRequestDetailDto> {
    const text = input.questions.map((q, i) => `${i + 1}. ${q}`).join('\n');
    await withHttpErrors(() =>
      this.prisma.$transaction(async (tx) => {
        const cr = await this.loadVisible(tx, id, user);
        await transitionChangeRequest(tx, {
          changeRequestId: id,
          to: 'CLARIFICATION_REQUIRED',
          actor: userActor(user),
          reason: text,
          context: auditContext(ctx),
          data: { pendingQuestions: input.questions },
        });
        await tx.approvalDecision.create({
          data: {
            changeRequestId: id,
            planId: cr.currentPlanId,
            decision: 'CLARIFICATION',
            actorId: user.id,
            comment: text,
          },
        });
        // Show the questions in the requester's assistant thread.
        const conversation = await tx.conversation.findFirst({
          where: { changeRequestId: id },
          orderBy: { createdAt: 'desc' },
          select: { id: true },
        });
        if (conversation) {
          await tx.conversationMessage.create({
            data: {
              conversationId: conversation.id,
              role: 'system',
              content: `${user.displayName} needs more information before approving:\n${text}`,
              metadata: { kind: 'clarification-request', questions: input.questions },
            },
          });
          await tx.conversation.update({
            where: { id: conversation.id },
            data: { status: 'OPEN' },
          });
        }
      }),
    );
    return this.get(id, user);
  }

  async retry(
    id: string,
    input: RetryInput,
    user: AuthUser,
    ctx: RequestContext,
  ): Promise<ChangeRequestDetailDto> {
    await withHttpErrors(() =>
      this.prisma.$transaction(async (tx) => {
        const cr = await this.loadVisible(tx, id, user);
        if (input.mode === 'recode' && !cr.currentPlanId) {
          throw new UnprocessableEntityException('There is no approved plan to retry coding with');
        }
        await transitionChangeRequest(tx, {
          changeRequestId: id,
          to: input.mode === 'reanalyze' ? 'SUBMITTED' : 'APPROVED',
          actor: userActor(user),
          reason: input.reason,
          metadata: { retry: input.mode },
          context: auditContext(ctx),
        });
        if (input.mode === 'reanalyze') {
          await this.queue.enqueueAnalyze(tx, { changeRequestId: id, trigger: 'retry' });
        }
      }),
    );
    return this.get(id, user);
  }

  private async loadVisible(tx: Tx, id: string, user: AuthUser) {
    const cr = await tx.changeRequest.findUnique({
      where: { id },
      select: { id: true, requesterId: true, currentPlanId: true },
    });
    if (!cr || !canView(user, cr)) throw new NotFoundException('Change request not found');
    return cr;
  }
}
