import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createPrismaClient, type PrismaClient, recordTransition } from '@evolvesales/db';
import { QUEUE, QUEUE_SCHEMA } from '@evolvesales/shared';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { AnalyzeHandler } from '../src/analysis/analyze.handler.js';
import { OrchestratorModule } from '../src/orchestrator.module.js';

let prisma: PrismaClient;

async function reset(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "notifications", "agent_jobs", "status_transitions", "approval_decisions", ' +
      '"implementation_plans", "conversation_messages", "conversations", "change_requests", ' +
      '"audit_logs", "users" RESTART IDENTITY CASCADE',
  );
}

async function submittedRequest(): Promise<{ id: string; requesterId: string }> {
  const user = await prisma.user.create({
    data: {
      email: `requester-${Date.now()}@test.local`,
      displayName: 'Requester',
      roles: ['SALES_USER'],
      passwordHash: 'not-used',
    },
  });
  return prisma.$transaction(async (tx) => {
    const cr = await tx.changeRequest.create({
      data: {
        key: `CR-${String(Math.floor(Math.random() * 9000) + 1000)}`,
        title: 'Export invoices',
        requesterId: user.id,
        screen: 'sales.invoices.list',
        originalRequest: 'I want to export invoices',
        structured: {},
        status: 'SUBMITTED',
      },
    });
    await recordTransition(tx, cr, null, {
      to: 'SUBMITTED',
      actor: { type: 'USER', userId: user.id, roles: ['SALES_USER'] },
    });
    return { id: cr.id, requesterId: user.id };
  });
}

describe('analyze job (Phase 2: no analysis agent yet)', () => {
  let app: INestApplication;
  let boss: PgBoss;

  beforeAll(async () => {
    const databaseUrl = inject('databaseUrl');
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: databaseUrl });
    prisma = createPrismaClient(databaseUrl);
    const moduleRef = await Test.createTestingModule({ imports: [OrchestratorModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init(); // starts pg-boss and the cr-analyze worker
    boss = new PgBoss({ connectionString: databaseUrl, schema: QUEUE_SCHEMA, supervise: false });
    await boss.start();
  });

  afterAll(async () => {
    await boss?.stop({ graceful: false });
    await app?.close();
    await prisma?.$disconnect();
  });

  beforeEach(reset);

  it('fails the request visibly instead of inventing a plan', async () => {
    const cr = await submittedRequest();

    const outcome = await app
      .get(AnalyzeHandler)
      .handle({ changeRequestId: cr.id, trigger: 'submitted' }, 'job-1');

    expect(outcome).toBe('failed');
    const after = await prisma.changeRequest.findUniqueOrThrow({
      where: { id: cr.id },
      include: { transitions: { orderBy: { createdAt: 'asc' } }, jobs: true, plans: true },
    });
    expect(after.status).toBe('FAILED');
    expect(after.plans).toHaveLength(0);
    expect(after.transitions.map((t) => [t.from, t.to, t.actorType])).toEqual([
      [null, 'SUBMITTED', 'USER'],
      ['SUBMITTED', 'ANALYZING', 'SYSTEM'],
      ['ANALYZING', 'FAILED', 'SYSTEM'],
    ]);
    expect(after.transitions[2]?.reason).toMatch(/Analysis agent not configured/);
    expect(after.jobs).toHaveLength(1);
    expect(after.jobs[0]).toMatchObject({
      type: 'ANALYZE',
      status: 'FAILED',
      agentKind: 'none',
      queueJobId: 'job-1',
    });
    expect(after.jobs[0]?.finishedAt).not.toBeNull();

    const notified = await prisma.notification.findMany({ where: { userId: cr.requesterId } });
    expect(notified.map((n) => n.type)).toContain('cr.status_changed');
    const audits = await prisma.auditLog.count({
      where: { entityId: cr.id, action: 'change_request.transition' },
    });
    expect(audits).toBe(3);
  });

  it('skips a job whose request is no longer SUBMITTED (idempotent)', async () => {
    const cr = await submittedRequest();
    const handler = app.get(AnalyzeHandler);
    await handler.handle({ changeRequestId: cr.id, trigger: 'submitted' }, 'job-a');

    const again = await handler.handle({ changeRequestId: cr.id, trigger: 'submitted' }, 'job-b');

    expect(again).toBe('skipped');
    expect(await prisma.agentJob.count({ where: { changeRequestId: cr.id } })).toBe(1);
  });

  it('consumes jobs from the pg-boss queue', async () => {
    const cr = await submittedRequest();

    await boss.send(QUEUE.Analyze, { changeRequestId: cr.id, trigger: 'submitted' });

    const deadline = Date.now() + 20_000;
    let status = 'SUBMITTED';
    while (Date.now() < deadline && status !== 'FAILED') {
      await new Promise((r) => setTimeout(r, 250));
      status = (await prisma.changeRequest.findUniqueOrThrow({ where: { id: cr.id } })).status;
    }
    expect(status).toBe('FAILED');
  });
});
