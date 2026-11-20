import { describe, expect, it } from 'vitest';
import { Role } from '../roles.js';
import {
  type Actor,
  checkTransition,
  CR_STATUSES,
  type CrStatus,
  findTransition,
  TERMINAL_STATUSES,
  TRANSITIONS,
} from './lifecycle.js';

const system: Actor = { type: 'SYSTEM' };
const user = (roles: Role[], isRequester = false): Actor => ({
  type: 'USER',
  userId: 'u1',
  roles,
  isRequester,
});

/** The §5 table, written out independently so a change to TRANSITIONS must be deliberate. */
const EXPECTED: Array<[CrStatus | null, CrStatus]> = [
  [null, 'SUBMITTED'],
  ['SUBMITTED', 'ANALYZING'],
  ['ANALYZING', 'AWAITING_APPROVAL'],
  ['ANALYZING', 'CLARIFICATION_REQUIRED'],
  ['ANALYZING', 'FAILED'],
  ['AWAITING_APPROVAL', 'APPROVED'],
  ['AWAITING_APPROVAL', 'REJECTED'],
  ['AWAITING_APPROVAL', 'CLARIFICATION_REQUIRED'],
  ['CLARIFICATION_REQUIRED', 'SUBMITTED'],
  ['APPROVED', 'ANALYZING'],
  ['APPROVED', 'CODING'],
  ['CODING', 'TESTING'],
  ['CODING', 'FAILED'],
  ['TESTING', 'FAILED'],
  ['TESTING', 'PULL_REQUEST_CREATED'],
  ['PULL_REQUEST_CREATED', 'REVIEW'],
  ['PULL_REQUEST_CREATED', 'FAILED'],
  ['REVIEW', 'STAGING'],
  ['REVIEW', 'REJECTED'],
  ['STAGING', 'PRODUCTION_APPROVAL'],
  ['PRODUCTION_APPROVAL', 'RELEASED'],
  ['FAILED', 'APPROVED'],
  ['FAILED', 'SUBMITTED'],
];

describe('lifecycle transition table', () => {
  it('contains exactly the documented transitions', () => {
    const actual = TRANSITIONS.map((t) => `${t.from ?? '∅'}→${t.to}`).toSorted();
    const expected = EXPECTED.map(([f, t]) => `${f ?? '∅'}→${t}`).toSorted();
    expect(actual).toEqual(expected);
  });

  it('allows or forbids every (from, to) pair as documented', () => {
    const allowed = new Set(EXPECTED.map(([f, t]) => `${f ?? '∅'}→${t}`));
    for (const from of [null, ...CR_STATUSES]) {
      for (const to of CR_STATUSES) {
        const key = `${from ?? '∅'}→${to}`;
        expect({ key, allowed: findTransition(from, to) !== undefined }).toEqual({
          key,
          allowed: allowed.has(key),
        });
      }
    }
  });

  it('has no transition out of a terminal state', () => {
    for (const s of TERMINAL_STATUSES) {
      expect(TRANSITIONS.some((t) => t.from === s)).toBe(false);
    }
  });
});

describe('checkTransition actors', () => {
  it('only the requester can submit and answer clarifications', () => {
    expect(checkTransition(null, 'SUBMITTED', user([Role.SalesUser], true)).ok).toBe(true);
    expect(checkTransition(null, 'SUBMITTED', user([Role.Admin], false)).ok).toBe(false);
    expect(checkTransition(null, 'SUBMITTED', system).ok).toBe(false);
    expect(
      checkTransition('CLARIFICATION_REQUIRED', 'SUBMITTED', user([Role.SalesUser], true)).ok,
    ).toBe(true);
  });

  it('system-only transitions reject users, even admins', () => {
    expect(checkTransition('SUBMITTED', 'ANALYZING', system).ok).toBe(true);
    expect(checkTransition('SUBMITTED', 'ANALYZING', user([Role.Admin])).ok).toBe(false);
    expect(checkTransition('APPROVED', 'CODING', user([Role.Admin])).ok).toBe(false);
  });

  it('approval needs CHANGE_APPROVER or ADMIN', () => {
    expect(checkTransition('AWAITING_APPROVAL', 'APPROVED', user([Role.ChangeApprover])).ok).toBe(
      true,
    );
    expect(checkTransition('AWAITING_APPROVAL', 'APPROVED', user([Role.Admin])).ok).toBe(true);
    for (const r of [Role.SalesUser, Role.SalesManager, Role.ReleaseManager]) {
      expect({ r, ok: checkTransition('AWAITING_APPROVAL', 'APPROVED', user([r])).ok }).toEqual({
        r,
        ok: false,
      });
    }
    expect(checkTransition('AWAITING_APPROVAL', 'APPROVED', system).ok).toBe(false);
  });

  it('reject, clarify and failures need a reason', () => {
    const approver = user([Role.ChangeApprover]);
    expect(checkTransition('AWAITING_APPROVAL', 'REJECTED', approver).ok).toBe(false);
    expect(checkTransition('AWAITING_APPROVAL', 'REJECTED', approver, '  ').ok).toBe(false);
    expect(checkTransition('AWAITING_APPROVAL', 'REJECTED', approver, 'Out of scope').ok).toBe(
      true,
    );
    expect(checkTransition('AWAITING_APPROVAL', 'CLARIFICATION_REQUIRED', approver).ok).toBe(false);
    expect(checkTransition('ANALYZING', 'FAILED', system).ok).toBe(false);
    expect(checkTransition('ANALYZING', 'FAILED', system, 'timeout').ok).toBe(true);
  });

  it('retries are admin-only', () => {
    expect(checkTransition('FAILED', 'SUBMITTED', user([Role.Admin]), 'retry').ok).toBe(true);
    expect(checkTransition('FAILED', 'SUBMITTED', user([Role.ChangeApprover]), 'retry').ok).toBe(
      false,
    );
    expect(checkTransition('FAILED', 'APPROVED', user([Role.Admin]), 'retry').ok).toBe(true);
  });

  it('release needs RELEASE_MANAGER or ADMIN', () => {
    expect(checkTransition('PRODUCTION_APPROVAL', 'RELEASED', user([Role.ReleaseManager])).ok).toBe(
      true,
    );
    expect(checkTransition('PRODUCTION_APPROVAL', 'RELEASED', user([Role.ChangeApprover])).ok).toBe(
      false,
    );
  });
});
