import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { inject } from 'vitest';
import { Role } from '@evolvesales/db';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/configure-app.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

/** Test-only password for fixture users in the throwaway test database. */
export const TEST_PASSWORD = 'correct-horse-battery-staple';

export interface TestApp {
  app: INestApplication;
  prisma: PrismaService;
  http: () => ReturnType<typeof request>;
  close: () => Promise<void>;
}

export async function createTestApp(env: Record<string, string> = {}): Promise<TestApp> {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: inject('databaseUrl'),
    JWT_ACCESS_SECRET: randomBytes(32).toString('hex'),
    COOKIE_SECURE: 'false',
    LOGIN_RATE_LIMIT_PER_MINUTE: '1000',
    LOGIN_MAX_FAILURES: '3',
    ...env,
  });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  const prisma = app.get(PrismaService);
  return {
    app,
    prisma,
    http: () => request(app.getHttpServer()),
    close: () => app.close(),
  };
}

export async function resetDatabase(prisma: PrismaService): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "invoice_items", "invoices", "invoice_sequences", "products", "customers", ' +
      '"refresh_tokens", "audit_logs", "users" RESTART IDENTITY CASCADE',
  );
}

export interface Fixtures {
  users: Record<
    'sales' | 'sales2' | 'manager' | 'approver' | 'admin',
    { id: string; email: string }
  >;
  customers: { active: string; inactive: string };
  products: { laptop: string; book: string; coffee: string; discontinued: string };
}

export async function seedFixtures(prisma: PrismaService): Promise<Fixtures> {
  const passwordHash = await argon2.hash(TEST_PASSWORD, { type: argon2.argon2id });
  const mk = (key: string, roles: Role[]) =>
    prisma.user.create({
      data: { email: `${key}@test.local`, displayName: key, roles, passwordHash },
      select: { id: true, email: true },
    });

  const users = {
    sales: await mk('sales', [Role.SALES_USER]),
    sales2: await mk('sales2', [Role.SALES_USER]),
    manager: await mk('manager', [Role.SALES_MANAGER]),
    approver: await mk('approver', [Role.CHANGE_APPROVER]),
    admin: await mk('admin', [Role.ADMIN]),
  };

  const active = await prisma.customer.create({ data: { code: 'C-1', name: 'Nile Trading' } });
  const inactive = await prisma.customer.create({
    data: { code: 'C-2', name: 'Closed Corp', isActive: false },
  });

  const product = (
    sku: string,
    name: string,
    unitPrice: string,
    taxRate: string,
    isActive = true,
  ) => prisma.product.create({ data: { sku, name, unitPrice, taxRate, isActive } });

  return {
    users,
    customers: { active: active.id, inactive: inactive.id },
    products: {
      laptop: (await product('P-1', 'Laptop', '1000.00', '0.1400')).id,
      book: (await product('P-2', 'Book', '50.00', '0.0000')).id,
      coffee: (await product('P-3', 'Coffee', '200.00', '0.0500')).id,
      discontinued: (await product('P-9', 'Fax', '10.00', '0.1400', false)).id,
    },
  };
}

export async function loginAs(t: TestApp, email: string): Promise<string> {
  const res = await t.http().post('/api/v1/auth/login').send({ email, password: TEST_PASSWORD });
  if (res.status !== 200) {
    throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return (res.body as { accessToken: string }).accessToken;
}
