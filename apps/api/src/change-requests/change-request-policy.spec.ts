import { describe, expect, it } from 'vitest';
import { Role } from '@evolvesales/shared';
import type { AuthUser } from '../auth/auth.types.js';
import { allowedActions, canView, canViewAll, selfApproval } from './change-request-policy.js';

const user = (id: string, roles: Role[]): AuthUser => ({
  id,
  email: `${id}@t`,
  displayName: id,
  roles,
});
const sales = user('s', [Role.SalesUser]);
const approver = user('a', [Role.ChangeApprover]);
const admin = user('x', [Role.Admin]);
const release = user('r', [Role.ReleaseManager]);
const cr = (status: Parameters<typeof allowedActions>[1]['status'], requesterId = 's') => ({
  status,
  requesterId,
  currentPlanId: null as string | null,
});

describe('change request visibility', () => {
  it('requesters see their own; oversight roles see all', () => {
    expect(canView(sales, { requesterId: 's' })).toBe(true);
    expect(canView(sales, { requesterId: 'other' })).toBe(false);
    expect(canViewAll(user('m', [Role.SalesManager]))).toBe(false);
    for (const u of [approver, admin, release]) expect(canViewAll(u)).toBe(true);
  });
});

describe('separation of duties', () => {
  it('blocks self-approval for approvers and requires an override for admins', () => {
    expect(selfApproval(approver, { requesterId: 'a' })).toBe('blocked');
    expect(selfApproval(admin, { requesterId: 'x' })).toBe('admin-override-required');
    expect(selfApproval(approver, { requesterId: 's' })).toBe('not-self');
  });
});

describe('allowedActions', () => {
  it('offers approve/reject/clarify to approvers only while awaiting approval', () => {
    expect(allowedActions(approver, cr('AWAITING_APPROVAL'))).toEqual([
      'approve',
      'reject',
      'clarify',
    ]);
    expect(allowedActions(sales, cr('AWAITING_APPROVAL'))).toEqual([]);
    expect(allowedActions(release, cr('AWAITING_APPROVAL'))).toEqual([]);
    expect(allowedActions(approver, cr('SUBMITTED'))).toEqual([]);
  });

  it('hides approve from an approver on their own request', () => {
    expect(allowedActions(approver, cr('AWAITING_APPROVAL', 'a'))).toEqual(['reject', 'clarify']);
    expect(allowedActions(admin, cr('AWAITING_APPROVAL', 'x'))).toContain('approve');
  });

  it('lets only the requester answer clarifications', () => {
    expect(allowedActions(sales, cr('CLARIFICATION_REQUIRED'))).toEqual(['answer']);
    expect(allowedActions(approver, cr('CLARIFICATION_REQUIRED'))).toEqual([]);
  });

  it('offers retries to admins on failed requests; recode needs a plan', () => {
    expect(allowedActions(admin, cr('FAILED'))).toEqual(['retry-reanalyze']);
    expect(allowedActions(admin, { ...cr('FAILED'), currentPlanId: 'p1' })).toEqual([
      'retry-reanalyze',
      'retry-recode',
    ]);
    expect(allowedActions(approver, cr('FAILED'))).toEqual([]);
  });
});
