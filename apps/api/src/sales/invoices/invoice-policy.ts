import { InvoiceStatus, Role } from '@evolvesales/shared';
import type { AuthUser } from '../../auth/auth.types.js';

/**
 * Pure permission rules for invoice actions (no I/O, unit-tested).
 * Route-level @Roles guards say who may attempt an action at all; these rules decide per invoice.
 */
export interface InvoiceFacts {
  status: InvoiceStatus;
  createdById: string;
}

export type Decision =
  { allowed: true } | { allowed: false; reason: string; status: 403 | 409 | 422 };

const ALLOW: Decision = { allowed: true };

const has = (user: AuthUser, role: Role) =>
  user.roles.includes(role) || user.roles.includes(Role.Admin);
const isSalesStaff = (user: AuthUser) => has(user, Role.SalesUser) || has(user, Role.SalesManager);
const isManager = (user: AuthUser) => has(user, Role.SalesManager);

export function canCreate(user: AuthUser): Decision {
  return isSalesStaff(user)
    ? ALLOW
    : { allowed: false, status: 403, reason: 'Only sales staff can create invoices' };
}

export function canEdit(user: AuthUser, invoice: InvoiceFacts): Decision {
  if (invoice.status !== InvoiceStatus.Draft) {
    return { allowed: false, status: 409, reason: 'Only draft invoices can be edited' };
  }
  if (isManager(user) || (isSalesStaff(user) && invoice.createdById === user.id)) return ALLOW;
  return {
    allowed: false,
    status: 403,
    reason: 'Only the creator or a sales manager can edit this draft',
  };
}

export function canConfirm(user: AuthUser, invoice: InvoiceFacts): Decision {
  if (invoice.status !== InvoiceStatus.Draft) {
    return { allowed: false, status: 409, reason: 'Only draft invoices can be confirmed' };
  }
  return isSalesStaff(user)
    ? ALLOW
    : { allowed: false, status: 403, reason: 'Only sales staff can confirm invoices' };
}

export function canCancel(
  user: AuthUser,
  invoice: InvoiceFacts,
  reason: string | undefined,
): Decision {
  if (invoice.status === InvoiceStatus.Cancelled) {
    return { allowed: false, status: 409, reason: 'Invoice is already cancelled' };
  }
  if (invoice.status === InvoiceStatus.Draft) {
    if (isManager(user) || (isSalesStaff(user) && invoice.createdById === user.id)) return ALLOW;
    return {
      allowed: false,
      status: 403,
      reason: 'Only the creator or a sales manager can cancel this draft',
    };
  }
  // Confirmed
  if (!isManager(user)) {
    return {
      allowed: false,
      status: 403,
      reason: 'Only a sales manager can cancel a confirmed invoice',
    };
  }
  if (!reason || reason.trim().length < 3) {
    return {
      allowed: false,
      status: 422,
      reason: 'A reason is required to cancel a confirmed invoice',
    };
  }
  return ALLOW;
}
