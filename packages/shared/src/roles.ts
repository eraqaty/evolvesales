/** Application roles. Mirrors the Prisma `Role` enum introduced in Phase 1. */
export const Role = {
  SalesUser: 'SALES_USER',
  SalesManager: 'SALES_MANAGER',
  ChangeApprover: 'CHANGE_APPROVER',
  ReleaseManager: 'RELEASE_MANAGER',
  Admin: 'ADMIN',
} as const;

export type Role = (typeof Role)[keyof typeof Role];

export const ALL_ROLES: readonly Role[] = Object.values(Role);

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ALL_ROLES as readonly string[]).includes(value);
}
