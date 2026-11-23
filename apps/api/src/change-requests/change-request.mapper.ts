import type { Prisma } from '@evolvesales/db';
import {
  type AgentJobDto,
  type ApprovalDecisionDto,
  type ChangeRequestAction,
  type ChangeRequestDetailDto,
  changeRequestProposalSchema,
  type ChangeRequestSummaryDto,
  type ImplementationPlanDto,
  type PersonRef,
  screenContextSchema,
  type StatusTransitionDto,
} from '@evolvesales/shared';

const person = { select: { id: true, displayName: true } } as const;

export const crSummaryInclude = { requester: person } satisfies Prisma.ChangeRequestInclude;

export const crDetailInclude = {
  requester: person,
  transitions: { orderBy: { createdAt: 'asc' }, include: { actor: person } },
  decisions: {
    orderBy: { createdAt: 'asc' },
    include: { actor: person, plan: { select: { version: true } } },
  },
  plans: { orderBy: { version: 'desc' } },
  jobs: { orderBy: { createdAt: 'desc' } },
  conversations: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true } },
} satisfies Prisma.ChangeRequestInclude;

type SummaryRow = Prisma.ChangeRequestGetPayload<{ include: typeof crSummaryInclude }>;
type DetailRow = Prisma.ChangeRequestGetPayload<{ include: typeof crDetailInclude }>;

const iso = (d: Date) => d.toISOString();
const isoOrNull = (d: Date | null) => (d ? d.toISOString() : null);
const ref = (u: { id: string; displayName: string }): PersonRef => ({
  id: u.id,
  displayName: u.displayName,
});

export function toCrSummaryDto(cr: SummaryRow): ChangeRequestSummaryDto {
  return {
    id: cr.id,
    key: cr.key,
    title: cr.title,
    status: cr.status,
    priority: cr.priority,
    screen: cr.screen,
    requester: ref(cr.requester),
    createdAt: iso(cr.createdAt),
    updatedAt: iso(cr.updatedAt),
  };
}

export function toCrDetailDto(
  cr: DetailRow,
  allowedActions: ChangeRequestAction[],
): ChangeRequestDetailDto {
  const context = screenContextSchema.safeParse(cr.screenContext);
  return {
    ...toCrSummaryDto(cr),
    originalRequest: cr.originalRequest,
    structured: changeRequestProposalSchema.parse(cr.structured),
    screenContext: context.success ? context.data : null,
    conversationId: cr.conversations[0]?.id ?? null,
    pendingQuestions: cr.pendingQuestions,
    transitions: cr.transitions.map((t): StatusTransitionDto => ({
      id: t.id,
      from: t.from,
      to: t.to,
      actorType: t.actorType,
      actor: t.actor ? ref(t.actor) : null,
      reason: t.reason,
      createdAt: iso(t.createdAt),
    })),
    decisions: cr.decisions.map((d): ApprovalDecisionDto => ({
      id: d.id,
      decision: d.decision,
      actor: ref(d.actor),
      comment: d.comment,
      planVersion: d.plan?.version ?? null,
      overrideReason: d.overrideReason,
      createdAt: iso(d.createdAt),
    })),
    plans: cr.plans.map((p): ImplementationPlanDto => ({
      id: p.id,
      version: p.version,
      baselineSha: p.baselineSha,
      plan: p.plan,
      verifiedCount: p.verifiedCount,
      assumptionCount: p.assumptionCount,
      agent: p.agent,
      model: p.model,
      createdAt: iso(p.createdAt),
    })),
    jobs: cr.jobs.map((j): AgentJobDto => ({
      id: j.id,
      type: j.type,
      status: j.status,
      agentKind: j.agentKind,
      model: j.model,
      error: j.error,
      costUsd: j.costUsd === null ? null : j.costUsd.toFixed(4),
      startedAt: isoOrNull(j.startedAt),
      finishedAt: isoOrNull(j.finishedAt),
      createdAt: iso(j.createdAt),
    })),
    allowedActions,
  };
}
