import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { inject } from 'vitest';
import { Role } from '@evolvesales/db';
import type { LanguageModel } from 'ai';
import { AppModule } from '../src/app.module.js';
import { LlmProvider } from '../src/assistant/llm.provider.js';
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

export interface TestAppOptions {
  /** Replaces the real LLM with a test model (e.g. the AI SDK's MockLanguageModelV4). */
  llm?: LanguageModel;
  /** Listen on a random port (needed for Socket.IO clients). */
  listen?: boolean;
}

export async function createTestApp(
  env: Record<string, string> = {},
  options: TestAppOptions = {},
): Promise<TestApp> {
  Object.assign(process.env, {
    NODE_ENV: 'test',
    DATABASE_URL: inject('databaseUrl'),
    JWT_ACCESS_SECRET: randomBytes(32).toString('hex'),
    COOKIE_SECURE: 'false',
    LOGIN_RATE_LIMIT_PER_MINUTE: '1000',
    PROFILE_RATE_LIMIT_PER_MINUTE: '1000',
    LOGIN_MAX_FAILURES: '3',
    ANTHROPIC_API_KEY: '',
    OPENAI_API_KEY: '',
    WHATSAPP_ENABLED: 'false',
    ...env,
  });
  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (options.llm) {
    const model = options.llm;
    builder = builder.overrideProvider(LlmProvider).useValue({
      status: () => ({ configured: true, provider: 'anthropic', model: 'test-model' }),
      model: () => model,
    });
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ rawBody: true });
  configureApp(app);
  if (options.listen) await app.listen(0, '127.0.0.1');
  else await app.init();
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
    'TRUNCATE "job_logs", "repositories", "agent_settings", "notifications", "agent_jobs", "status_transitions", "approval_decisions", ' +
      '"implementation_plans", "conversation_messages", "pending_actions", "outbound_messages", ' +
      '"inbound_channel_events", "phone_verifications", "conversations", "change_requests", ' +
      '"invoice_items", "invoices", "invoice_sequences", "products", "customers", ' +
      '"refresh_tokens", "audit_logs", "users" RESTART IDENTITY CASCADE',
  );
  await prisma.$executeRawUnsafe('ALTER SEQUENCE "change_request_key_seq" RESTART WITH 1');
  await prisma.$executeRawUnsafe(
    `DELETE FROM pgboss.job WHERE name IN ('cr-analyze', 'whatsapp-inbound', 'github-repo-sync')`,
  );
}

/** Number of queued `cr-analyze` jobs for a request (pg-boss table). */
export async function analyzeJobsFor(prisma: PrismaService, changeRequestId: string) {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
    `SELECT count(*) AS n FROM pgboss.job WHERE name = 'cr-analyze' AND data->>'changeRequestId' = $1`,
    changeRequestId,
  );
  return Number(rows[0]?.n ?? 0);
}

/** Parses a Server-Sent Events body into its JSON `data:` payloads. */
export function parseSse<T = unknown>(body: string): T[] {
  return body
    .split('\n\n')
    .map((block) => block.split('\n').find((l) => l.startsWith('data: ')))
    .filter((l): l is string => l !== undefined)
    .map((l) => JSON.parse(l.slice('data: '.length)) as T);
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
