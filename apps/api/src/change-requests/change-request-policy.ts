import { type ChangeRequestAction, type CrStatus, Role } from '@evolvesales/shared';
import type { AuthUser } from '../auth/auth.types.js';

/** Roles that see every change request (approvers, release managers, admins). */
const OVERSIGHT_ROLES: readonly Role[] = [Role.ChangeApprover, Role.ReleaseManager, Role.Admin];
const APPROVER_ROLES: readonly Role[] = [Role.ChangeApprover, Role.Admin];

const has = (user: AuthUser, roles: readonly Role[]) => user.roles.some((r) => roles.includes(r));

export function canViewAll(user: AuthUser): boolean {
  return has(user, OVERSIGHT_ROLES);
}

export function canView(user: AuthUser, cr: { requesterId: string }): boolean {
  return canViewAll(user) || cr.requesterId === user.id;
}

export type SelfApproval = 'not-self' | 'blocked' | 'admin-override-required';

/**
 * Separation of duties (§0, §8): a requester cannot approve their own request,
 * even with the approver role. An Admin may, but only with an audited override reason.
 */
export function selfApproval(user: AuthUser, cr: { requesterId: string }): SelfApproval {
  if (cr.requesterId !== user.id) return 'not-self';
  return user.roles.includes(Role.Admin) ? 'admin-override-required' : 'blocked';
}

/** What `user` may do now; drives the UI. The server re-checks every action independently. */
export function allowedActions(
  user: AuthUser,
  cr: { status: CrStatus; requesterId: string; currentPlanId: string | null },
): ChangeRequestAction[] {
  const actions: ChangeRequestAction[] = [];
  const isAdmin = user.roles.includes(Role.Admin);

  if (cr.status === 'AWAITING_APPROVAL' && has(user, APPROVER_ROLES)) {
    if (selfApproval(user, cr) !== 'blocked') actions.push('approve');
    actions.push('reject', 'clarify');
  }
  if (cr.status === 'CLARIFICATION_REQUIRED' && cr.requesterId === user.id) {
    actions.push('answer');
  }
  if (cr.status === 'FAILED' && isAdmin) {
    actions.push('retry-reanalyze');
    if (cr.currentPlanId) actions.push('retry-recode');
  }
  return actions;
}
