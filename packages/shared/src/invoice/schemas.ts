import { z } from 'zod';
import { dec } from '../money.js';

export const InvoiceStatus = {
  Draft: 'DRAFT',
  Confirmed: 'CONFIRMED',
  Cancelled: 'CANCELLED',
} as const;
export type InvoiceStatus = (typeof InvoiceStatus)[keyof typeof InvoiceStatus];
export const INVOICE_STATUSES = Object.values(InvoiceStatus) as [InvoiceStatus, ...InvoiceStatus[]];

/** Accepts a JSON number or numeric string; outputs a canonical decimal string. */
function decimalString(opts: { scale: number; min?: number; max?: number; gt?: number }) {
  const pattern = new RegExp(`^-?\\d{1,15}(\\.\\d{1,${opts.scale}})?$`);
  return z
    .union([z.string().trim(), z.number().finite()])
    .transform((v) => (typeof v === 'number' ? String(v) : v))
    .pipe(
      z
        .string()
        .regex(pattern, `must be a number with at most ${opts.scale} decimal places`)
        .refine((v) => opts.min === undefined || dec(v).gte(opts.min), {
          message: `must be at least ${opts.min}`,
        })
        .refine((v) => opts.max === undefined || dec(v).lte(opts.max), {
          message: `must be at most ${opts.max}`,
        })
        .refine((v) => opts.gt === undefined || dec(v).gt(opts.gt), {
          message: `must be > ${opts.gt}`,
        }),
    );
}

export const quantitySchema = decimalString({ scale: 3, gt: 0, max: 1_000_000 });
export const unitPriceSchema = decimalString({ scale: 2, min: 0, max: 100_000_000 });
export const percentSchema = decimalString({ scale: 3, min: 0, max: 100 });

const isoDate = z.iso.date();

export const invoiceItemInputSchema = z.object({
  productId: z.uuid(),
  description: z.string().trim().max(500).optional(),
  quantity: quantitySchema,
  unitPrice: unitPriceSchema,
  lineDiscountPct: percentSchema.default('0'),
});
export type InvoiceItemInput = z.infer<typeof invoiceItemInputSchema>;

const invoiceBodyShape = {
  customerId: z.uuid(),
  issueDate: isoDate,
  dueDate: isoDate.optional(),
  headerDiscountPct: percentSchema.default('0'),
  notes: z.string().trim().max(2000).optional(),
  items: z.array(invoiceItemInputSchema).max(200),
};

function dueAfterIssue(v: { issueDate: string; dueDate?: string | undefined }): boolean {
  return v.dueDate === undefined || v.dueDate >= v.issueDate;
}
const dueDateMessage = { message: 'dueDate must be on or after issueDate', path: ['dueDate'] };

export const createInvoiceSchema = z.object(invoiceBodyShape).refine(dueAfterIssue, dueDateMessage);
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;

export const updateInvoiceSchema = z
  .object({ ...invoiceBodyShape, version: z.number().int().min(0) })
  .refine(dueAfterIssue, dueDateMessage);
export type UpdateInvoiceInput = z.infer<typeof updateInvoiceSchema>;

export const confirmInvoiceSchema = z.object({ version: z.number().int().min(0) });
export type ConfirmInvoiceInput = z.infer<typeof confirmInvoiceSchema>;

export const cancelInvoiceSchema = z.object({
  version: z.number().int().min(0),
  reason: z.string().trim().max(500).optional(),
});
export type CancelInvoiceInput = z.infer<typeof cancelInvoiceSchema>;

export const INVOICE_SORT_FIELDS = ['issueDate', 'number', 'grandTotal', 'createdAt'] as const;

export const listInvoicesQuerySchema = z
  .object({
    search: z.string().trim().max(100).optional(),
    status: z.enum(INVOICE_STATUSES).optional(),
    customerId: z.uuid().optional(),
    dateFrom: isoDate.optional(),
    dateTo: isoDate.optional(),
    minTotal: unitPriceSchema.optional(),
    maxTotal: unitPriceSchema.optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    sort: z.enum(INVOICE_SORT_FIELDS).default('issueDate'),
    order: z.enum(['asc', 'desc']).default('desc'),
  })
  .refine((q) => !q.dateFrom || !q.dateTo || q.dateFrom <= q.dateTo, {
    message: 'dateFrom must be on or before dateTo',
    path: ['dateTo'],
  });
export type ListInvoicesQuery = z.infer<typeof listInvoicesQuerySchema>;

export const lookupQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type LookupQuery = z.infer<typeof lookupQuerySchema>;

/** `INV-2026-000001` */
export function formatInvoiceNumber(year: number, sequence: number): string {
  return `INV-${year}-${String(sequence).padStart(6, '0')}`;
}
