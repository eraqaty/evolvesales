import { Controller, Get, Query } from '@nestjs/common';
import { type LookupQuery, lookupQuerySchema } from '@evolvesales/shared';
import { PrismaService } from '../prisma/prisma.service.js';

export interface CustomerOption {
  id: string;
  code: string;
  name: string;
  email: string | null;
  phone: string | null;
}

export interface ProductOption {
  id: string;
  sku: string;
  name: string;
  unit: string;
  unitPrice: string;
  taxRate: string;
}

/** Read-only lookups for the invoice editor. Only active records are offered. */
@Controller()
export class LookupsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('customers')
  async customers(@Query({ schema: lookupQuerySchema }) q: LookupQuery): Promise<CustomerOption[]> {
    const rows = await this.prisma.customer.findMany({
      where: {
        isActive: true,
        ...(q.search && {
          OR: [
            { name: { contains: q.search, mode: 'insensitive' } },
            { code: { contains: q.search, mode: 'insensitive' } },
          ],
        }),
      },
      orderBy: { name: 'asc' },
      take: q.limit,
      select: { id: true, code: true, name: true, email: true, phone: true },
    });
    return rows;
  }

  @Get('products')
  async products(@Query({ schema: lookupQuerySchema }) q: LookupQuery): Promise<ProductOption[]> {
    const rows = await this.prisma.product.findMany({
      where: {
        isActive: true,
        ...(q.search && {
          OR: [
            { name: { contains: q.search, mode: 'insensitive' } },
            { sku: { contains: q.search, mode: 'insensitive' } },
          ],
        }),
      },
      orderBy: { name: 'asc' },
      take: q.limit,
    });
    return rows.map((p) => ({
      id: p.id,
      sku: p.sku,
      name: p.name,
      unit: p.unit,
      unitPrice: p.unitPrice.toFixed(2),
      taxRate: p.taxRate.toFixed(4),
    }));
  }
}
