/**
 * Development / demo seed. Idempotent: users, customers and products are upserted;
 * sample invoices are created only when the invoices table is empty.
 *
 * Requires SEED_USER_PASSWORD (all demo users share it; dev/staging only — never production).
 */
import path from 'node:path';
import argon2 from 'argon2';
import { config as loadEnv } from 'dotenv';
import { calculateInvoice } from '@evolvesales/shared';
import {
  allocateInvoiceNumber,
  createPrismaClient,
  InvoiceStatus,
  Role,
  type PrismaClient,
} from '../src/index.js';

loadEnv({ path: path.resolve(import.meta.dirname, '../../../.env'), quiet: true });

const SEED_USERS = [
  { email: 'sales@evolvesales.local', displayName: 'Sara Sales', roles: [Role.SALES_USER] },
  { email: 'manager@evolvesales.local', displayName: 'Mona Manager', roles: [Role.SALES_MANAGER] },
  {
    email: 'approver@evolvesales.local',
    displayName: 'Adam Approver',
    roles: [Role.CHANGE_APPROVER],
  },
  {
    email: 'release@evolvesales.local',
    displayName: 'Rami Release',
    roles: [Role.RELEASE_MANAGER],
  },
  { email: 'admin@evolvesales.local', displayName: 'Ali Admin', roles: [Role.ADMIN] },
] as const;

const CUSTOMERS = [
  ['C-0001', 'Nile Valley Trading Co.', 'Cairo, Nasr City'],
  ['C-0002', 'Delta Office Supplies', 'Mansoura, El Gomhoreya St.'],
  ['C-0003', 'Alexandria Marine Services', 'Alexandria, Smouha'],
  ['C-0004', 'Pyramids Tech Solutions', 'Giza, Dokki'],
  ['C-0005', 'Red Sea Hospitality Group', 'Hurghada, El Kawther'],
  ['C-0006', 'Sinai Construction LLC', 'Sharm El Sheikh'],
  ['C-0007', 'Upper Egypt Agro Industries', 'Assiut, Industrial Zone'],
  ['C-0008', 'Canal Logistics', 'Ismailia, El Sheikh Zayed'],
  ['C-0009', 'Heliopolis Medical Center', 'Cairo, Heliopolis'],
  ['C-0010', 'Zamalek Design Studio', 'Cairo, Zamalek'],
  ['C-0011', 'Fayoum Textiles', 'Fayoum, Industrial Area'],
  ['C-0012', 'Maadi International School', 'Cairo, Maadi'],
  ['C-0013', 'Tanta Pharmaceuticals', 'Tanta, Al Bahr St.'],
  ['C-0014', 'Luxor Heritage Tours', 'Luxor, Corniche'],
  ['C-0015', 'New Capital Realty (inactive)', 'New Administrative Capital'],
] as const;

// [sku, name, unit, unitPrice, taxRate]
const PRODUCTS = [
  ['P-1001', 'Laptop 14" Business', 'pcs', '38500.00', '0.1400'],
  ['P-1002', 'Laptop 16" Workstation', 'pcs', '72900.00', '0.1400'],
  ['P-1003', '27" IPS Monitor', 'pcs', '9850.00', '0.1400'],
  ['P-1004', 'Wireless Keyboard & Mouse', 'set', '1450.00', '0.1400'],
  ['P-1005', 'USB-C Docking Station', 'pcs', '5200.00', '0.1400'],
  ['P-1006', 'Laser Printer A4', 'pcs', '12400.00', '0.1400'],
  ['P-1007', 'Printer Toner Cartridge', 'pcs', '2350.00', '0.1400'],
  ['P-1008', 'Office Chair Ergonomic', 'pcs', '6750.00', '0.1400'],
  ['P-1009', 'Standing Desk 140cm', 'pcs', '14900.00', '0.1400'],
  ['P-1010', 'Network Switch 24-port', 'pcs', '8600.00', '0.1400'],
  ['P-1011', 'Wi-Fi 6 Access Point', 'pcs', '4300.00', '0.1400'],
  ['P-1012', 'UPS 1500VA', 'pcs', '7900.00', '0.1400'],
  ['P-1013', 'A4 Copy Paper (box of 5 reams)', 'box', '1150.00', '0.1400'],
  ['P-1014', 'Whiteboard 120x90', 'pcs', '2100.00', '0.1400'],
  ['P-1015', 'Conference Speakerphone', 'pcs', '6450.00', '0.1400'],
  ['P-2001', 'IT Support (hourly)', 'hour', '850.00', '0.1400'],
  ['P-2002', 'Network Installation (daily)', 'day', '6500.00', '0.1400'],
  ['P-2003', 'Annual Maintenance Contract', 'year', '45000.00', '0.1400'],
  ['P-3001', 'Business English Course Book', 'pcs', '420.00', '0.0000'],
  ['P-3002', 'Accounting Handbook (Arabic)', 'pcs', '380.00', '0.0000'],
  ['P-3003', 'First Aid Kit', 'pcs', '950.00', '0.0000'],
  ['P-4001', 'Bottled Water (carton)', 'carton', '95.00', '0.0500'],
  ['P-4002', 'Coffee Beans 1kg', 'kg', '780.00', '0.0500'],
  ['P-4003', 'Tea Bags (box of 100)', 'box', '165.00', '0.0500'],
  ['P-9001', 'Legacy Fax Machine (discontinued)', 'pcs', '3200.00', '0.1400'],
] as const;

/** Deterministic PRNG (mulberry32) so every seed run produces the same demo data. */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function seedUsers(prisma: PrismaClient): Promise<Map<string, string>> {
  const password = process.env.SEED_USER_PASSWORD;
  if (!password || password.length < 12) {
    throw new Error('SEED_USER_PASSWORD must be set (at least 12 characters) to seed demo users');
  }
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const ids = new Map<string, string>();
  for (const u of SEED_USERS) {
    const user = await prisma.user.upsert({
      where: { email: u.email },
      create: { email: u.email, displayName: u.displayName, roles: [...u.roles], passwordHash },
      update: { displayName: u.displayName, roles: [...u.roles], passwordHash, isActive: true },
    });
    ids.set(u.email, user.id);
  }
  return ids;
}

async function seedCatalog(prisma: PrismaClient): Promise<void> {
  for (const [code, name, address] of CUSTOMERS) {
    const isActive = !name.includes('(inactive)');
    await prisma.customer.upsert({
      where: { code },
      create: {
        code,
        name,
        address,
        isActive,
        email: `accounts@${code.toLowerCase()}.example`,
        phone: `+20 2 ${code.slice(2)} 0000`,
        taxNumber: `TX-${code.slice(2)}-EG`,
      },
      update: { name, address, isActive },
    });
  }
  for (const [sku, name, unit, unitPrice, taxRate] of PRODUCTS) {
    const isActive = !name.includes('(discontinued)');
    await prisma.product.upsert({
      where: { sku },
      create: { sku, name, unit, unitPrice, taxRate, isActive },
      update: { name, unit, unitPrice, taxRate, isActive },
    });
  }
}

async function seedInvoices(prisma: PrismaClient, userIds: Map<string, string>): Promise<number> {
  if ((await prisma.invoice.count()) > 0) return 0;

  const rand = prng(20261120);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
  const customers = await prisma.customer.findMany({ where: { isActive: true } });
  const products = await prisma.product.findMany({ where: { isActive: true } });
  const sales = userIds.get('sales@evolvesales.local')!;
  const manager = userIds.get('manager@evolvesales.local')!;
  const today = new Date();
  const COUNT = 30;

  for (let i = 0; i < COUNT; i++) {
    const issue = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
    );
    issue.setUTCDate(issue.getUTCDate() - Math.floor(rand() * 90));
    const due = new Date(issue);
    due.setUTCDate(due.getUTCDate() + 30);

    const lineCount = 1 + Math.floor(rand() * 4);
    const lines = Array.from({ length: lineCount }, () => {
      const product = pick(products);
      return {
        product,
        quantity: String(1 + Math.floor(rand() * 10)),
        unitPrice: product.unitPrice.toFixed(2),
        lineDiscountPct: rand() < 0.3 ? String(pick([5, 10, 15])) : '0',
        taxRate: product.taxRate.toFixed(4),
      };
    });
    const headerDiscountPct = rand() < 0.2 ? String(pick([2.5, 5])) : '0';
    const calc = calculateInvoice({ headerDiscountPct, lines });

    const roll = rand();
    const status =
      roll < 0.45
        ? InvoiceStatus.CONFIRMED
        : roll < 0.85
          ? InvoiceStatus.DRAFT
          : InvoiceStatus.CANCELLED;
    const createdById = rand() < 0.7 ? sales : manager;
    const confirmedAt =
      status === InvoiceStatus.DRAFT ? null : new Date(issue.getTime() + 3_600_000);
    const wasConfirmedBeforeCancel = status === InvoiceStatus.CANCELLED && rand() < 0.5;

    await prisma.$transaction(async (tx) => {
      const number = await allocateInvoiceNumber(tx, issue.getUTCFullYear());
      await tx.invoice.create({
        data: {
          number,
          customerId: pick(customers).id,
          status,
          issueDate: issue,
          dueDate: due,
          headerDiscountPct,
          subtotal: calc.subtotal,
          discountTotal: calc.discountTotal,
          taxableTotal: calc.taxableTotal,
          taxTotal: calc.taxTotal,
          grandTotal: calc.grandTotal,
          notes: i % 7 === 0 ? 'Delivery to main warehouse.' : null,
          createdById,
          confirmedById:
            status === InvoiceStatus.CONFIRMED || wasConfirmedBeforeCancel ? createdById : null,
          confirmedAt:
            status === InvoiceStatus.CONFIRMED || wasConfirmedBeforeCancel ? confirmedAt : null,
          cancelledById: status === InvoiceStatus.CANCELLED ? manager : null,
          cancelledAt: status === InvoiceStatus.CANCELLED ? confirmedAt : null,
          cancelReason: status === InvoiceStatus.CANCELLED ? 'Customer withdrew the order.' : null,
          items: {
            create: lines.map((l, idx) => ({
              lineNo: idx + 1,
              productId: l.product.id,
              quantity: l.quantity,
              unitPrice: l.unitPrice,
              lineDiscountPct: l.lineDiscountPct,
              taxRate: l.taxRate,
              ...calc.lines[idx]!,
            })),
          },
        },
      });
    });
  }
  return COUNT;
}

async function main(): Promise<void> {
  const prisma = createPrismaClient(process.env.DATABASE_URL ?? '');
  try {
    const userIds = await seedUsers(prisma);
    await seedCatalog(prisma);
    const invoices = await seedInvoices(prisma, userIds);
    console.warn(
      `Seed complete: ${userIds.size} users, ${CUSTOMERS.length} customers, ` +
        `${PRODUCTS.length} products, ${invoices} new invoices.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

await main();
