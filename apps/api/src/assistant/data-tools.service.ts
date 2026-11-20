import { Injectable } from '@nestjs/common';
import type { Prisma } from '@evolvesales/db';
import { CR_STATUS_LABELS, dec, INVOICE_STATUSES, roundMoney } from '@evolvesales/shared';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import { canView } from '../change-requests/change-request-policy.js';
import type { RequestContext } from '../common/request-context.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { fromIsoDate, toIsoDate } from '../sales/invoices/invoice.mapper.js';

/** Max rows any data tool returns (§19.4). */
export const MAX_ROWS = 10;

const isoDate = z.iso.date();
const period = {
  dateFrom: isoDate.describe('Start date, inclusive (YYYY-MM-DD)'),
  dateTo: isoDate.describe('End date, inclusive (YYYY-MM-DD)'),
};

export const dataToolSchemas = {
  findInvoices: z.object({
    search: z.string().max(100).optional().describe('Invoice number, customer name or code'),
    status: z.enum(INVOICE_STATUSES).optional(),
    customerCode: z.string().max(40).optional(),
    dateFrom: isoDate.optional(),
    dateTo: isoDate.optional(),
  }),
  getInvoice: z.object({ number: z.string().max(40).describe('e.g. INV-2026-000012') }),
  salesSummary: z.object({ ...period, groupBy: z.enum(['customer', 'product', 'day']) }),
  topCustomers: z.object({ ...period, n: z.number().int().min(1).max(MAX_ROWS).default(5) }),
  customerSummary: z.object({ code: z.string().max(40) }),
  myChangeRequests: z.object({}),
  changeRequestStatus: z.object({ key: z.string().max(20).describe('e.g. CR-0007') }),
} as const;

export type DataToolName = keyof typeof dataToolSchemas;
type Args<K extends DataToolName> = z.infer<(typeof dataToolSchemas)[K]>;

/** Formats a decimal amount as "EGP 1,234.50". */
export function egp(value: Prisma.Decimal | string | number | null): string {
  const fixed = roundMoney(dec(value?.toString() ?? '0')).toFixed(2);
  const [int = '0', frac = '00'] = fixed.split('.');
  const sign = int.startsWith('-') ? '-' : '';
  const digits = sign ? int.slice(1) : int;
  return `EGP ${sign}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}`;
}

/**
 * Typed, read-only queries the assistant may call. The LLM never writes SQL; every call runs
 * with the asking user's permissions and is audited as `assistant.data_query`.
 */
@Injectable()
export class DataToolsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async run<K extends DataToolName>(
    name: K,
    args: Args<K>,
    user: AuthUser,
    ctx: RequestContext,
  ): Promise<unknown> {
    await this.audit.record(
      { action: 'assistant.data_query', entityType: 'Assistant', after: { tool: name, args } },
      ctx,
    );
    switch (name) {
      case 'findInvoices':
        return this.findInvoices(args as Args<'findInvoices'>);
      case 'getInvoice':
        return this.getInvoice(args as Args<'getInvoice'>);
      case 'salesSummary':
        return this.salesSummary(args as Args<'salesSummary'>);
      case 'topCustomers': {
        const a = args as Args<'topCustomers'>;
        const rows = await this.salesSummary({ ...a, groupBy: 'customer' });
        return { ...rows, groups: rows.groups.slice(0, a.n) };
      }
      case 'customerSummary':
        return this.customerSummary(args as Args<'customerSummary'>);
      case 'myChangeRequests':
        return this.myChangeRequests(user);
      case 'changeRequestStatus':
        return this.changeRequestStatus(args as Args<'changeRequestStatus'>, user);
    }
    return { error: 'unknown tool' };
  }

  private async findInvoices(a: Args<'findInvoices'>) {
    const where: Prisma.InvoiceWhereInput = {
      ...(a.status && { status: a.status }),
      ...(a.customerCode && {
        customer: { code: { equals: a.customerCode, mode: 'insensitive' } },
      }),
      ...((a.dateFrom || a.dateTo) && {
        issueDate: {
          ...(a.dateFrom && { gte: fromIsoDate(a.dateFrom) }),
          ...(a.dateTo && { lte: fromIsoDate(a.dateTo) }),
        },
      }),
      ...(a.search && {
        OR: [
          { number: { contains: a.search, mode: 'insensitive' } },
          { customer: { name: { contains: a.search, mode: 'insensitive' } } },
          { customer: { code: { contains: a.search, mode: 'insensitive' } } },
        ],
      }),
    };
    const [total, rows] = await Promise.all([
      this.prisma.invoice.count({ where }),
      this.prisma.invoice.findMany({
        where,
        include: { customer: { select: { code: true, name: true } } },
        orderBy: [{ issueDate: 'desc' }, { number: 'desc' }],
        take: MAX_ROWS,
      }),
    ]);
    return {
      totalMatching: total,
      shown: rows.length,
      invoices: rows.map((i) => ({
        number: i.number,
        customer: `${i.customer.name} (${i.customer.code})`,
        status: i.status,
        issueDate: toIsoDate(i.issueDate),
        dueDate: i.dueDate ? toIsoDate(i.dueDate) : null,
        grandTotal: egp(i.grandTotal),
      })),
    };
  }

  private async getInvoice(a: Args<'getInvoice'>) {
    const i = await this.prisma.invoice.findFirst({
      where: { number: { equals: a.number.trim(), mode: 'insensitive' } },
      include: {
        customer: { select: { code: true, name: true } },
        items: {
          orderBy: { lineNo: 'asc' },
          take: MAX_ROWS,
          include: { product: { select: { sku: true, name: true } } },
        },
        _count: { select: { items: true } },
      },
    });
    if (!i) return { found: false };
    return {
      found: true,
      number: i.number,
      status: i.status,
      customer: `${i.customer.name} (${i.customer.code})`,
      issueDate: toIsoDate(i.issueDate),
      dueDate: i.dueDate ? toIsoDate(i.dueDate) : null,
      subtotal: egp(i.subtotal),
      discountTotal: egp(i.discountTotal),
      taxTotal: egp(i.taxTotal),
      grandTotal: egp(i.grandTotal),
      lineCount: i._count.items,
      lines: i.items.map((l) => ({
        product: `${l.product.name} (${l.product.sku})`,
        quantity: l.quantity.toString(),
        unitPrice: egp(l.unitPrice),
        lineTotal: egp(l.lineTotal),
      })),
    };
  }

  /** Confirmed invoices only: drafts and cancelled invoices are not sales. */
  private async salesSummary(a: Args<'salesSummary'>) {
    const invoiceWhere: Prisma.InvoiceWhereInput = {
      status: 'CONFIRMED',
      issueDate: { gte: fromIsoDate(a.dateFrom), lte: fromIsoDate(a.dateTo) },
    };
    const basis = 'Confirmed invoices only, amounts include tax (grand total).';

    if (a.groupBy === 'product') {
      const rows = await this.prisma.invoiceItem.groupBy({
        by: ['productId'],
        where: { invoice: invoiceWhere },
        _sum: { lineTotal: true, quantity: true },
        orderBy: { _sum: { lineTotal: 'desc' } },
        take: MAX_ROWS,
      });
      const products = await this.prisma.product.findMany({
        where: { id: { in: rows.map((r) => r.productId) } },
        select: { id: true, sku: true, name: true },
      });
      const byId = new Map(products.map((p) => [p.id, p]));
      return {
        basis: 'Confirmed invoices only, line totals include tax.',
        groups: rows.map((r) => {
          const p = byId.get(r.productId);
          return {
            product: p ? `${p.name} (${p.sku})` : r.productId,
            quantity: r._sum.quantity?.toString() ?? '0',
            total: egp(r._sum.lineTotal),
          };
        }),
      };
    }

    if (a.groupBy === 'day') {
      const rows = await this.prisma.invoice.groupBy({
        by: ['issueDate'],
        where: invoiceWhere,
        _sum: { grandTotal: true },
        _count: { _all: true },
        orderBy: { issueDate: 'asc' },
        take: MAX_ROWS,
      });
      return {
        basis: `${basis} At most ${MAX_ROWS} days are listed.`,
        groups: rows.map((r) => ({
          day: toIsoDate(r.issueDate),
          invoices: r._count._all,
          total: egp(r._sum.grandTotal),
        })),
      };
    }

    const rows = await this.prisma.invoice.groupBy({
      by: ['customerId'],
      where: invoiceWhere,
      _sum: { grandTotal: true },
      _count: { _all: true },
      orderBy: { _sum: { grandTotal: 'desc' } },
      take: MAX_ROWS,
    });
    const customers = await this.prisma.customer.findMany({
      where: { id: { in: rows.map((r) => r.customerId) } },
      select: { id: true, code: true, name: true },
    });
    const byId = new Map(customers.map((c) => [c.id, c]));
    return {
      basis,
      groups: rows.map((r) => {
        const c = byId.get(r.customerId);
        return {
          customer: c ? `${c.name} (${c.code})` : r.customerId,
          invoices: r._count._all,
          total: egp(r._sum.grandTotal),
        };
      }),
    };
  }

  private async customerSummary(a: Args<'customerSummary'>) {
    const c = await this.prisma.customer.findFirst({
      where: { code: { equals: a.code.trim(), mode: 'insensitive' } },
    });
    if (!c) return { found: false };
    const [byStatus, last] = await Promise.all([
      this.prisma.invoice.groupBy({
        by: ['status'],
        where: { customerId: c.id },
        _count: { _all: true },
        _sum: { grandTotal: true },
      }),
      this.prisma.invoice.findFirst({
        where: { customerId: c.id },
        orderBy: { issueDate: 'desc' },
        select: { number: true, issueDate: true },
      }),
    ]);
    return {
      found: true,
      code: c.code,
      name: c.name,
      active: c.isActive,
      invoicesByStatus: byStatus.map((s) => ({
        status: s.status,
        count: s._count._all,
        total: egp(s._sum.grandTotal),
      })),
      lastInvoice: last ? { number: last.number, issueDate: toIsoDate(last.issueDate) } : null,
    };
  }

  private async myChangeRequests(user: AuthUser) {
    const rows = await this.prisma.changeRequest.findMany({
      where: { requesterId: user.id },
      orderBy: { createdAt: 'desc' },
      take: MAX_ROWS,
      select: { key: true, title: true, status: true, updatedAt: true },
    });
    return {
      requests: rows.map((r) => ({
        key: r.key,
        title: r.title,
        status: CR_STATUS_LABELS[r.status],
        updatedAt: r.updatedAt.toISOString(),
      })),
    };
  }

  private async changeRequestStatus(a: Args<'changeRequestStatus'>, user: AuthUser) {
    const cr = await this.prisma.changeRequest.findUnique({
      where: { key: a.key.trim().toUpperCase() },
      select: { key: true, title: true, status: true, requesterId: true, updatedAt: true },
    });
    // Same answer for "missing" and "not visible to you".
    if (!cr || !canView(user, cr)) return { found: false };
    return {
      found: true,
      key: cr.key,
      title: cr.title,
      status: CR_STATUS_LABELS[cr.status],
      updatedAt: cr.updatedAt.toISOString(),
    };
  }
}
