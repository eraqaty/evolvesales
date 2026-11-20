import { Role } from '../roles.js';

/** Change-request lifecycle states (docs/IMPLEMENTATION_PLAN.md §5). Mirrors the Prisma enum. */
export const CrStatus = {
  Submitted: 'SUBMITTED',
  Analyzing: 'ANALYZING',
  AwaitingApproval: 'AWAITING_APPROVAL',
  ClarificationRequired: 'CLARIFICATION_REQUIRED',
  Approved: 'APPROVED',
  Rejected: 'REJECTED',
  Coding: 'CODING',
  Testing: 'TESTING',
  PullRequestCreated: 'PULL_REQUEST_CREATED',
  Review: 'REVIEW',
  Staging: 'STAGING',
  ProductionApproval: 'PRODUCTION_APPROVAL',
  Released: 'RELEASED',
  Failed: 'FAILED',
} as const;
export type CrStatus = (typeof CrStatus)[keyof typeof CrStatus];
export const CR_STATUSES = Object.values(CrStatus);

export function isCrStatus(value: unknown): value is CrStatus {
  return typeof value === 'string' && (CR_STATUSES as readonly string[]).includes(value);
}

/** Who may perform a transition. */
export type TransitionActor =
  { kind: 'system' } | { kind: 'requester' } | { kind: 'roles'; roles: readonly Role[] };

export interface TransitionRule {
  from: CrStatus | null;
  to: CrStatus;
  actor: TransitionActor;
  /** The action needs a non-empty reason/comment. */
  reasonRequired?: boolean;
  description: string;
}

const SYSTEM: TransitionActor = { kind: 'system' };
const REQUESTER: TransitionActor = { kind: 'requester' };
const APPROVERS: TransitionActor = { kind: 'roles', roles: [Role.ChangeApprover, Role.Admin] };
const ADMIN: TransitionActor = { kind: 'roles', roles: [Role.Admin] };
const RELEASE: TransitionActor = { kind: 'roles', roles: [Role.ReleaseManager, Role.Admin] };

/** The single source of truth for allowed transitions; used by the API and the Orchestrator. */
export const TRANSITIONS: readonly TransitionRule[] = [
  { from: null, to: CrStatus.Submitted, actor: REQUESTER, description: 'Assistant submit' },
  { from: 'SUBMITTED', to: 'ANALYZING', actor: SYSTEM, description: 'analyze job started' },
  { from: 'ANALYZING', to: 'AWAITING_APPROVAL', actor: SYSTEM, description: 'Plan verified' },
  {
    from: 'ANALYZING',
    to: 'CLARIFICATION_REQUIRED',
    actor: SYSTEM,
    description: 'Agent reports blocking ambiguity',
  },
  {
    from: 'ANALYZING',
    to: 'FAILED',
    actor: SYSTEM,
    reasonRequired: true,
    description: 'Job error or timeout',
  },
  { from: 'AWAITING_APPROVAL', to: 'APPROVED', actor: APPROVERS, description: 'Approve' },
  {
    from: 'AWAITING_APPROVAL',
    to: 'REJECTED',
    actor: APPROVERS,
    reasonRequired: true,
    description: 'Reject',
  },
  {
    from: 'AWAITING_APPROVAL',
    to: 'CLARIFICATION_REQUIRED',
    actor: APPROVERS,
    reasonRequired: true,
    description: 'Questions to the requester',
  },
  {
    from: 'CLARIFICATION_REQUIRED',
    to: 'SUBMITTED',
    actor: REQUESTER,
    description: 'Requester answered; re-analysis',
  },
  { from: 'APPROVED', to: 'ANALYZING', actor: SYSTEM, description: 'Baseline drift revalidation' },
  { from: 'APPROVED', to: 'CODING', actor: SYSTEM, description: 'code job started' },
  { from: 'CODING', to: 'TESTING', actor: SYSTEM, description: 'Agent finished editing' },
  {
    from: 'CODING',
    to: 'FAILED',
    actor: SYSTEM,
    reasonRequired: true,
    description: 'Coding failed',
  },
  {
    from: 'TESTING',
    to: 'FAILED',
    actor: SYSTEM,
    reasonRequired: true,
    description: 'Checks or policy gate failed',
  },
  { from: 'TESTING', to: 'PULL_REQUEST_CREATED', actor: SYSTEM, description: 'PR opened' },
  { from: 'PULL_REQUEST_CREATED', to: 'REVIEW', actor: SYSTEM, description: 'CI green' },
  {
    from: 'PULL_REQUEST_CREATED',
    to: 'FAILED',
    actor: SYSTEM,
    reasonRequired: true,
    description: 'CI red',
  },
  { from: 'REVIEW', to: 'STAGING', actor: SYSTEM, description: 'Merged and staging smoke passed' },
  {
    from: 'REVIEW',
    to: 'REJECTED',
    actor: SYSTEM,
    reasonRequired: true,
    description: 'PR closed unmerged',
  },
  { from: 'STAGING', to: 'PRODUCTION_APPROVAL', actor: SYSTEM, description: 'Awaiting release' },
  { from: 'PRODUCTION_APPROVAL', to: 'RELEASED', actor: RELEASE, description: 'Released' },
  {
    from: 'FAILED',
    to: 'APPROVED',
    actor: ADMIN,
    reasonRequired: true,
    description: 'Retry coding with the same plan',
  },
  {
    from: 'FAILED',
    to: 'SUBMITTED',
    actor: ADMIN,
    reasonRequired: true,
    description: 'Re-analyse from scratch',
  },
];

/** Terminal states: no transition leaves them. */
export const TERMINAL_STATUSES: readonly CrStatus[] = [CrStatus.Rejected, CrStatus.Released];

export function findTransition(from: CrStatus | null, to: CrStatus): TransitionRule | undefined {
  return TRANSITIONS.find((t) => t.from === from && t.to === to);
}

/** The party attempting a transition. */
export type Actor =
  | { type: 'SYSTEM' }
  | { type: 'USER'; userId: string; roles: readonly Role[]; isRequester: boolean };

export type TransitionErrorCode = 'invalid_transition' | 'reason_required' | 'actor_not_allowed';

export type TransitionCheck =
  { ok: true; rule: TransitionRule } | { ok: false; code: TransitionErrorCode; reason: string };

/**
 * Pure check: is `actor` allowed to move a request from `from` to `to`?
 * Separation of duties (no self-approval) is enforced by the caller, because Admins may override it.
 */
export function checkTransition(
  from: CrStatus | null,
  to: CrStatus,
  actor: Actor,
  reason?: string | null,
): TransitionCheck {
  const rule = findTransition(from, to);
  if (!rule) {
    return {
      ok: false,
      code: 'invalid_transition',
      reason: `Transition ${from ?? '∅'} → ${to} is not allowed`,
    };
  }

  const allowed = (() => {
    switch (rule.actor.kind) {
      case 'system':
        return actor.type === 'SYSTEM';
      case 'requester':
        return actor.type === 'USER' && actor.isRequester;
      case 'roles': {
        const roles = rule.actor.roles;
        return actor.type === 'USER' && actor.roles.some((r) => roles.includes(r));
      }
    }
  })();

  if (!allowed) {
    return {
      ok: false,
      code: 'actor_not_allowed',
      reason: `You may not move this request from ${from ?? '∅'} to ${to}`,
    };
  }
  if (rule.reasonRequired && !reason?.trim()) {
    return {
      ok: false,
      code: 'reason_required',
      reason: `A reason is required for ${from ?? '∅'} → ${to}`,
    };
  }
  return { ok: true, rule };
}

export const CR_STATUS_LABELS: Record<CrStatus, string> = {
  SUBMITTED: 'Submitted',
  ANALYZING: 'Analyzing',
  AWAITING_APPROVAL: 'Awaiting approval',
  CLARIFICATION_REQUIRED: 'Clarification required',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  CODING: 'Coding',
  TESTING: 'Testing',
  PULL_REQUEST_CREATED: 'Pull request created',
  REVIEW: 'Review',
  STAGING: 'Staging',
  PRODUCTION_APPROVAL: 'Production approval',
  RELEASED: 'Released',
  FAILED: 'Failed',
};

/** Statuses an approver must act on. */
export const APPROVAL_STATUSES: readonly CrStatus[] = [CrStatus.AwaitingApproval];
