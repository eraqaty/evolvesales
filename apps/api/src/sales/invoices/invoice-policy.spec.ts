import { describe, expect, it } from 'vitest';
import { InvoiceStatus, Role } from '@evolvesales/shared';
import type { AuthUser } from '../../auth/auth.types.js';
import { canCancel, canConfirm, canCreate, canEdit } from './invoice-policy.js';

const user = (id: string, ...roles: Role[]): AuthUser => ({
  id,
  email: `${id}@test`,
  displayName: id,
  roles,
});

const sales = user('sales', Role.SalesUser);
const otherSales = user('other', Role.SalesUser);
const manager = user('manager', Role.SalesManager);
const admin = user('admin', Role.Admin);
const approver = user('approver', Role.ChangeApprover);

const draftBySales = { status: InvoiceStatus.Draft, createdById: 'sales' };
const confirmed = { status: InvoiceStatus.Confirmed, createdById: 'sales' };
const cancelled = { status: InvoiceStatus.Cancelled, createdById: 'sales' };

describe('invoice policy', () => {
  it('lets sales staff and admins create, but not approvers', () => {
    expect(canCreate(sales).allowed).toBe(true);
    expect(canCreate(manager).allowed).toBe(true);
    expect(canCreate(admin).allowed).toBe(true);
    expect(canCreate(approver)).toMatchObject({ allowed: false, status: 403 });
  });

  it('allows editing a draft by its creator or a manager only', () => {
    expect(canEdit(sales, draftBySales).allowed).toBe(true);
    expect(canEdit(manager, draftBySales).allowed).toBe(true);
    expect(canEdit(otherSales, draftBySales)).toMatchObject({ allowed: false, status: 403 });
  });

  it('never allows editing confirmed or cancelled invoices', () => {
    expect(canEdit(manager, confirmed)).toMatchObject({ allowed: false, status: 409 });
    expect(canEdit(admin, cancelled)).toMatchObject({ allowed: false, status: 409 });
  });

  it('confirms only drafts', () => {
    expect(canConfirm(otherSales, draftBySales).allowed).toBe(true);
    expect(canConfirm(sales, confirmed)).toMatchObject({ allowed: false, status: 409 });
    expect(canConfirm(approver, draftBySales)).toMatchObject({ allowed: false, status: 403 });
  });

  it('cancels drafts by creator/manager without a reason', () => {
    expect(canCancel(sales, draftBySales, undefined).allowed).toBe(true);
    expect(canCancel(otherSales, draftBySales, undefined)).toMatchObject({
      allowed: false,
      status: 403,
    });
  });

  it('requires a manager and a reason to cancel a confirmed invoice', () => {
    expect(canCancel(sales, confirmed, 'Customer returned goods')).toMatchObject({ status: 403 });
    expect(canCancel(manager, confirmed, undefined)).toMatchObject({ allowed: false, status: 422 });
    expect(canCancel(manager, confirmed, '  ')).toMatchObject({ allowed: false, status: 422 });
    expect(canCancel(manager, confirmed, 'Customer returned goods').allowed).toBe(true);
    expect(canCancel(admin, confirmed, 'Duplicate invoice').allowed).toBe(true);
  });

  it('treats cancelled as final', () => {
    expect(canCancel(admin, cancelled, 'again')).toMatchObject({ allowed: false, status: 409 });
  });
});
