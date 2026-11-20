import type { Prisma } from '@evolvesales/db';
import type { InvoiceDetailDto, InvoiceSummaryDto, UserRef } from '@evolvesales/shared';

export const invoiceSummaryInclude = {
  customer: { select: { id: true, code: true, name: true } },
} satisfies Prisma.InvoiceInclude;

const userRef = { select: { id: true, displayName: true } } as const;

export const invoiceDetailInclude = {
  customer: { select: { id: true, code: true, name: true } },
  items: {
    orderBy: { lineNo: 'asc' },
    include: { product: { select: { id: true, sku: true, name: true, unit: true } } },
  },
  createdBy: userRef,
  confirmedBy: userRef,
  cancelledBy: userRef,
} satisfies Prisma.InvoiceInclude;

type SummaryRow = Prisma.InvoiceGetPayload<{ include: typeof invoiceSummaryInclude }>;
type DetailRow = Prisma.InvoiceGetPayload<{ include: typeof invoiceDetailInclude }>;

/** `@db.Date` columns come back as UTC midnight. */
export const toIsoDate = (d: Date): string => d.toISOString().slice(0, 10);
export const fromIsoDate = (s: string): Date => new Date(`${s}T00:00:00.000Z`);

export function toSummaryDto(row: SummaryRow): InvoiceSummaryDto {
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    issueDate: toIsoDate(row.issueDate),
    dueDate: row.dueDate ? toIsoDate(row.dueDate) : null,
    currency: row.currency,
    customer: row.customer,
    grandTotal: row.grandTotal.toFixed(2),
    createdAt: row.createdAt.toISOString(),
  };
}

export function toDetailDto(row: DetailRow): InvoiceDetailDto {
  const ref = (u: { id: string; displayName: string } | null): UserRef | null => u && { ...u };
  return {
    ...toSummaryDto(row),
    headerDiscountPct: row.headerDiscountPct.toFixed(3),
    subtotal: row.subtotal.toFixed(2),
    discountTotal: row.discountTotal.toFixed(2),
    taxableTotal: row.taxableTotal.toFixed(2),
    taxTotal: row.taxTotal.toFixed(2),
    notes: row.notes,
    version: row.version,
    items: row.items.map((i) => ({
      id: i.id,
      lineNo: i.lineNo,
      product: i.product,
      description: i.description,
      quantity: i.quantity.toFixed(3),
      unitPrice: i.unitPrice.toFixed(2),
      lineDiscountPct: i.lineDiscountPct.toFixed(3),
      taxRate: i.taxRate.toFixed(4),
      lineGross: i.lineGross.toFixed(2),
      lineDiscount: i.lineDiscount.toFixed(2),
      headerDiscountShare: i.headerDiscountShare.toFixed(2),
      taxableAmount: i.taxableAmount.toFixed(2),
      taxAmount: i.taxAmount.toFixed(2),
      lineTotal: i.lineTotal.toFixed(2),
    })),
    createdBy: { ...row.createdBy },
    confirmedBy: ref(row.confirmedBy),
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    cancelledBy: ref(row.cancelledBy),
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    cancelReason: row.cancelReason,
    updatedAt: row.updatedAt.toISOString(),
  };
}
