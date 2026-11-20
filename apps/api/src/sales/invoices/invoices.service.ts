import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { allocateInvoiceNumber, InvoiceStatus as DbInvoiceStatus, Prisma } from '@evolvesales/db';
import {
  type CalcResult,
  calculateInvoice,
  type CancelInvoiceInput,
  type CreateInvoiceInput,
  CURRENCY,
  type InvoiceDetailDto,
  type InvoiceItemInput,
  type InvoiceStatus,
  type InvoiceSummaryDto,
  type ListInvoicesQuery,
  type Page,
  type UpdateInvoiceInput,
} from '@evolvesales/shared';
import { AuditService } from '../../audit/audit.service.js';
import type { AuthUser } from '../../auth/auth.types.js';
import type { RequestContext } from '../../common/request-context.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  fromIsoDate,
  invoiceDetailInclude,
  invoiceSummaryInclude,
  toDetailDto,
  toSummaryDto,
} from './invoice.mapper.js';
import { canCancel, canConfirm, canCreate, canEdit, type Decision } from './invoice-policy.js';

type Tx = Prisma.TransactionClient;

interface PricedLine {
  productId: string;
  description: string | null;
  quantity: string;
  unitPrice: string;
  lineDiscountPct: string;
  taxRate: string;
}

@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(q: ListInvoicesQuery): Promise<Page<InvoiceSummaryDto>> {
    const where: Prisma.InvoiceWhereInput = {
      ...(q.status && { status: q.status }),
      ...(q.customerId && { customerId: q.customerId }),
      ...((q.dateFrom || q.dateTo) && {
        issueDate: {
          ...(q.dateFrom && { gte: fromIsoDate(q.dateFrom) }),
          ...(q.dateTo && { lte: fromIsoDate(q.dateTo) }),
        },
      }),
      ...((q.minTotal || q.maxTotal) && {
        grandTotal: {
          ...(q.minTotal && { gte: q.minTotal }),
          ...(q.maxTotal && { lte: q.maxTotal }),
        },
      }),
      ...(q.search && {
        OR: [
          { number: { contains: q.search, mode: 'insensitive' } },
          { customer: { name: { contains: q.search, mode: 'insensitive' } } },
          { customer: { code: { contains: q.search, mode: 'insensitive' } } },
        ],
      }),
    };

    const [total, rows] = await Promise.all([
      this.prisma.invoice.count({ where }),
      this.prisma.invoice.findMany({
        where,
        include: invoiceSummaryInclude,
        orderBy: [{ [q.sort]: q.order }, { number: q.order }],
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
    ]);
    return { items: rows.map(toSummaryDto), total, page: q.page, pageSize: q.pageSize };
  }

  async get(id: string): Promise<InvoiceDetailDto> {
    return toDetailDto(await this.loadDetail(this.prisma, id));
  }

  async create(
    input: CreateInvoiceInput,
    user: AuthUser,
    ctx: RequestContext,
  ): Promise<InvoiceDetailDto> {
    enforce(canCreate(user));
    return this.prisma.$transaction(async (tx) => {
      await this.assertActiveCustomer(tx, input.customerId);
      const { lines, calc } = await this.price(tx, input.items, input.headerDiscountPct);
      const issueDate = fromIsoDate(input.issueDate);
      const number = await allocateInvoiceNumber(tx, issueDate.getUTCFullYear());

      const created = await tx.invoice.create({
        data: {
          number,
          customerId: input.customerId,
          issueDate,
          dueDate: input.dueDate ? fromIsoDate(input.dueDate) : null,
          currency: CURRENCY,
          headerDiscountPct: input.headerDiscountPct,
          notes: input.notes || null,
          createdById: user.id,
          ...totals(calc),
          items: { create: itemRows(lines, calc) },
        },
        include: invoiceDetailInclude,
      });
      const dto = toDetailDto(created);
      await this.audit.record(
        { action: 'invoice.created', entityType: 'Invoice', entityId: dto.id, after: dto },
        ctx,
        tx,
      );
      return dto;
    });
  }

  async update(
    id: string,
    input: UpdateInvoiceInput,
    user: AuthUser,
    ctx: RequestContext,
  ): Promise<InvoiceDetailDto> {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.loadDetail(tx, id);
      enforce(canEdit(user, facts(before)));
      await this.assertActiveCustomer(tx, input.customerId);
      const { lines, calc } = await this.price(tx, input.items, input.headerDiscountPct);

      const issueDate = fromIsoDate(input.issueDate);
      if (issueDate.getUTCFullYear() !== before.issueDate.getUTCFullYear()) {
        throw new UnprocessableEntityException(
          'The issue date cannot move to another year: the invoice number belongs to its year',
        );
      }

      const updated = await tx.invoice.updateMany({
        where: { id, version: input.version, status: DbInvoiceStatus.DRAFT },
        data: {
          customerId: input.customerId,
          issueDate,
          dueDate: input.dueDate ? fromIsoDate(input.dueDate) : null,
          headerDiscountPct: input.headerDiscountPct,
          notes: input.notes || null,
          updatedById: user.id,
          version: { increment: 1 },
          ...totals(calc),
        },
      });
      if (updated.count !== 1) throw versionConflict();

      await tx.invoiceItem.deleteMany({ where: { invoiceId: id } });
      await tx.invoiceItem.createMany({
        data: itemRows(lines, calc).map((row) => ({ ...row, invoiceId: id })),
      });

      const after = toDetailDto(await this.loadDetail(tx, id));
      await this.audit.record(
        {
          action: 'invoice.updated',
          entityType: 'Invoice',
          entityId: id,
          before: toDetailDto(before),
          after,
        },
        ctx,
        tx,
      );
      return after;
    });
  }

  async confirm(
    id: string,
    version: number,
    user: AuthUser,
    ctx: RequestContext,
  ): Promise<InvoiceDetailDto> {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.loadDetail(tx, id);
      enforce(canConfirm(user, facts(before)));
      if (before.items.length === 0) {
        throw new UnprocessableEntityException(
          'An invoice needs at least one item to be confirmed',
        );
      }
      await this.assertActiveCustomer(tx, before.customerId);
      const inactive = await tx.product.findMany({
        where: { id: { in: before.items.map((i) => i.productId) }, isActive: false },
        select: { sku: true },
      });
      if (inactive.length > 0) {
        throw new UnprocessableEntityException(
          `Products no longer available: ${inactive.map((p) => p.sku).join(', ')}`,
        );
      }

      // Recalculate from the stored line values so the confirmed totals are guaranteed consistent.
      const calc = calculateInvoice({
        headerDiscountPct: before.headerDiscountPct.toString(),
        lines: before.items.map((i) => ({
          quantity: i.quantity.toString(),
          unitPrice: i.unitPrice.toString(),
          lineDiscountPct: i.lineDiscountPct.toString(),
          taxRate: i.taxRate.toString(),
        })),
      });

      const updated = await tx.invoice.updateMany({
        where: { id, version, status: DbInvoiceStatus.DRAFT },
        data: {
          status: DbInvoiceStatus.CONFIRMED,
          confirmedById: user.id,
          confirmedAt: new Date(),
          updatedById: user.id,
          version: { increment: 1 },
          ...totals(calc),
        },
      });
      if (updated.count !== 1) throw versionConflict();

      const after = toDetailDto(await this.loadDetail(tx, id));
      await this.audit.record(
        {
          action: 'invoice.confirmed',
          entityType: 'Invoice',
          entityId: id,
          before: toDetailDto(before),
          after,
        },
        ctx,
        tx,
      );
      return after;
    });
  }

  async cancel(
    id: string,
    input: CancelInvoiceInput,
    user: AuthUser,
    ctx: RequestContext,
  ): Promise<InvoiceDetailDto> {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.loadDetail(tx, id);
      enforce(canCancel(user, facts(before), input.reason));

      const updated = await tx.invoice.updateMany({
        where: { id, version: input.version, status: before.status },
        data: {
          status: DbInvoiceStatus.CANCELLED,
          cancelledById: user.id,
          cancelledAt: new Date(),
          cancelReason: input.reason?.trim() || null,
          updatedById: user.id,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) throw versionConflict();

      const after = toDetailDto(await this.loadDetail(tx, id));
      await this.audit.record(
        {
          action: 'invoice.cancelled',
          entityType: 'Invoice',
          entityId: id,
          before: toDetailDto(before),
          after,
        },
        ctx,
        tx,
      );
      return after;
    });
  }

  private async loadDetail(db: Tx | PrismaService, id: string) {
    const row = await db.invoice.findUnique({ where: { id }, include: invoiceDetailInclude });
    if (!row) throw new NotFoundException('Invoice not found');
    return row;
  }

  private async assertActiveCustomer(tx: Tx, customerId: string): Promise<void> {
    const customer = await tx.customer.findUnique({ where: { id: customerId } });
    if (!customer || !customer.isActive) {
      throw new UnprocessableEntityException('Customer not found or inactive');
    }
  }

  /** Resolves products (tax rate always from the product, never from the client) and runs the math. */
  private async price(
    tx: Tx,
    items: InvoiceItemInput[],
    headerDiscountPct: string,
  ): Promise<{ lines: PricedLine[]; calc: CalcResult }> {
    const ids = [...new Set(items.map((i) => i.productId))];
    const products = await tx.product.findMany({ where: { id: { in: ids }, isActive: true } });
    const byId = new Map(products.map((p) => [p.id, p]));

    const lines = items.map((item, index) => {
      const product = byId.get(item.productId);
      if (!product) {
        throw new UnprocessableEntityException(`Line ${index + 1}: product not found or inactive`);
      }
      return {
        productId: product.id,
        description: item.description || null,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        lineDiscountPct: item.lineDiscountPct,
        taxRate: product.taxRate.toString(),
      };
    });

    return { lines, calc: calculateInvoice({ headerDiscountPct, lines }) };
  }
}

function facts(row: { status: InvoiceStatus; createdById: string }) {
  return { status: row.status, createdById: row.createdById };
}

function enforce(decision: Decision): void {
  if (decision.allowed) return;
  if (decision.status === 403) throw new ForbiddenException(decision.reason);
  if (decision.status === 409) throw new ConflictException(decision.reason);
  throw new UnprocessableEntityException(decision.reason);
}

function versionConflict(): HttpException {
  return new ConflictException('The invoice was changed by someone else. Reload it and try again.');
}

function totals(calc: CalcResult) {
  return {
    subtotal: calc.subtotal,
    discountTotal: calc.discountTotal,
    taxableTotal: calc.taxableTotal,
    taxTotal: calc.taxTotal,
    grandTotal: calc.grandTotal,
  };
}

function itemRows(lines: PricedLine[], calc: CalcResult) {
  return lines.map((line, index) => ({
    lineNo: index + 1,
    ...line,
    ...calc.lines[index]!,
  }));
}
