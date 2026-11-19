import { describe, expect, it } from 'vitest';
import { ALL_ROLES, isRole, Role } from './roles.js';

describe('roles', () => {
  it('lists every role exactly once', () => {
    expect(ALL_ROLES).toHaveLength(5);
    expect(new Set(ALL_ROLES).size).toBe(ALL_ROLES.length);
  });

  it('recognises valid roles and rejects anything else', () => {
    expect(isRole(Role.ChangeApprover)).toBe(true);
    expect(isRole('SUPERUSER')).toBe(false);
    expect(isRole(undefined)).toBe(false);
  });
});
