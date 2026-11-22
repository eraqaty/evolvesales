import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createPrismaClient, type PrismaClient, recordTransition } from '@evolvesales/db';
import { type ImplementationPlan, QUEUE, QUEUE_SCHEMA } from '@evolvesales/shared';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { ReaperService } from '../src/agent/reaper.service.js';
import {
  AnalysisAgent,
  type AnalysisOutcome,
  type AnalysisRequest,
} from '../src/analysis/analysis-agent.js';
import { AnalyzeHandler } from '../src/analysis/analyze.handler.js';
import { OrchestratorConfig, orchestratorEnvSchema } from '../src/config.js';
import { GitHubAppService } from '../src/github/github-app.service.js';
import { RepoSyncService } from '../src/github/repo-sync.service.js';
import { OrchestratorModule } from '../src/orchestrator.module.js';
import type { PrismaService } from '../src/prisma.service.js';
import { FakeGitHub, type FakeRepo } from './fake-github.js';

const HEAD = 'c0ffee'.padEnd(40, '0');
const LIST_PAGE = [
  "import { Button } from '@mantine/core';",
  '',
  'export function InvoiceListPage() {',
  '  return <Button>New invoice</Button>;',
  '}',
].join('\n');

const REPO: FakeRepo = {
  id: 900_000_001,
  fullName: 'eraqaty/evolvesales',
  defaultBranch: 'main',
  headSha: HEAD,
  files: {
    'apps/web/src/features/invoices/InvoiceListPage.tsx': LIST_PAGE,
    'README.md': '# EvolveSales',
  },
};

function goodPlan(overrides: Partial<ImplementationPlan> = {}): ImplementationPlan {
  const path = 'apps/web/src/features/invoices/InvoiceListPage.tsx';
  return {
    originalRequest: 'Add an export button',
    technicalInterpretation: 'Add a CSV export next to New invoice',
    proposedImplementation: [{ step: 1, description: 'Add the button' }],
    affectedComponents: [
      {
        layer: 'frontend',
        path,
        change: 'modify',
        reason: 'Button goes here',
        verified: true,
        evidence: {
          path,
          startLine: 3,
          endLine: 4,
          excerpt: 'export function InvoiceListPage() {\n  return <Button>New invoice</Button>;',
        },
      },
      {
        layer: 'frontend',
        path,
        change: 'modify',
        reason: 'Invented evidence',
        verified: true,
        evidence: {
          path,
          startLine: 1,
          endLine: 1,
          excerpt: 'export const alreadyHasExport = true;',
        },
      },
      {
        layer: 'tests',
        path: 'apps/web/src/features/invoices/Export.test.tsx',
        change: 'add',
        reason: 'test',
        verified: false,
      },
    ],
    databaseChanges: { required: false, migrations: [], dataImpact: '' },
    newDependencies: [],
    testRequirements: [
      {
        type: 'unit',
        description: 'renders',
        path: 'apps/web/src/features/invoices/Export.test.tsx',
      },
    ],
    risks: [],
    complexity: { level: 'S', rationale: 'small', estimatedFilesChanged: 2 },
    acceptanceCriteria: ['The button exists'],
    assumptions: [],
    blockingQuestions: [],
    ...overrides,
  };
}

class FakeAgent extends AnalysisAgent {
  readonly kind = 'fake-agent';
  calls: AnalysisRequest[] = [];
  next: (req: AnalysisRequest) => AnalysisOutcome = (req) => ({
    ok: true,
    plan: goodPlan(),
    headSha: req.baselineSha,
    numTurns: 7,
    agent: this.kind,
    model: 'claude-opus-5-5',
    usage: { inputTokens: 1200, outputTokens: 300 },
    costUsd: 0.4321,
    containerId: 'c'.repeat(64),
    imageDigest: 'sha256:abc',
  });

  notReadyReason(): string | null {
    return null;
  }

  analyze(req: AnalysisRequest): Promise<AnalysisOutcome> {
    this.calls.push(req);
    req.log('INFO', 'agent', 'Read README.md');
    req.log('INFO', 'runner', `leaked ${req.githubToken} in a log line`);
    return Promise.resolve(this.next(req));
  }
}

let prisma: PrismaClient;
const github = new FakeGitHub();
const agent = new FakeAgent();

async function reset(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "job_logs", "notifications", "agent_jobs", "status_transitions", "approval_decisions", ' +
      '"implementation_plans", "conversation_messages", "conversations", "change_requests", ' +
      '"repositories", "agent_settings", "audit_logs", "users" RESTART IDENTITY CASCADE',
  );
}

async function submittedRequest(): Promise<{ id: string; requesterId: string }> {
  const user = await prisma.user.create({
    data: {
      email: `requester-${Date.now()}-${Math.random()}@test.local`,
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
        structured: { title: 'Export invoices' },
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

async function setCaps(perJob: string, daily: string) {
  await prisma.agentSettings.upsert({
    where: { id: 1 },
    create: { id: 1, analyzeMaxBudgetUsd: perJob, dailyBudgetUsd: daily },
    update: { analyzeMaxBudgetUsd: perJob, dailyBudgetUsd: daily },
  });
}

async function authorizeRepo() {
  return prisma.repository.create({
    data: {
      githubId: BigInt(REPO.id),
      fullName: REPO.fullName,
      installationId: 4242n,
      defaultBranch: 'main',
      isAuthorized: true,
      lastSyncedAt: new Date(),
    },
  });
}

const detail = (id: string) =>
  prisma.changeRequest.findUniqueOrThrow({
    where: { id },
    include: {
      transitions: { orderBy: { createdAt: 'asc' } },
      jobs: { include: { logs: { orderBy: { seq: 'asc' } } } },
      plans: true,
    },
  });

describe('analyze job (Phase 3)', () => {
  let app: INestApplication;
  let boss: PgBoss;
  let handler: AnalyzeHandler;

  beforeAll(async () => {
    await github.start();
    github.installations = [{ id: 4242, repos: [REPO] }];
    const keyDir = mkdtempSync(path.join(tmpdir(), 'evs-gh-'));
    const keyPath = path.join(keyDir, 'app.pem');
    writeFileSync(keyPath, github.privateKeyPem);
    const databaseUrl = inject('databaseUrl');
    Object.assign(process.env, {
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
      GITHUB_APP_ID: '123',
      GITHUB_APP_PRIVATE_KEY_PATH: keyPath,
      GITHUB_API_BASE_URL: github.baseUrl,
      GITHUB_CLONE_BASE_URL: 'https://github.example',
    });
    prisma = createPrismaClient(databaseUrl);
    const moduleRef = await Test.createTestingModule({ imports: [OrchestratorModule] })
      .overrideProvider(AnalysisAgent)
      .useValue(agent)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init(); // starts pg-boss and the workers
    handler = app.get(AnalyzeHandler);
    boss = new PgBoss({ connectionString: databaseUrl, schema: QUEUE_SCHEMA, supervise: false });
    await boss.start();
  });

  afterAll(async () => {
    await boss?.stop({ graceful: false });
    await app?.close();
    await prisma?.$disconnect();
    await github.stop();
  });

  beforeEach(async () => {
    await reset();
    github.reset();
    agent.calls = [];
    agent.next = new FakeAgent().next;
  });

  it('produces a verified plan and waits for approval', async () => {
    await setCaps('5.00', '20.00');
    const repo = await authorizeRepo();
    const cr = await submittedRequest();

    expect(await handler.handle({ changeRequestId: cr.id, trigger: 'submitted' }, 'job-1')).toBe(
      'awaiting-approval',
    );

    const after = await detail(cr.id);
    expect(after.status).toBe('AWAITING_APPROVAL');
    expect(after.baselineSha).toBe(HEAD);
    expect(after.repositoryId).toBe(repo.id);
    expect(after.plans).toHaveLength(1);
    const plan = after.plans[0]!;
    expect(after.currentPlanId).toBe(plan.id);
    expect(plan).toMatchObject({
      version: 1,
      baselineSha: HEAD,
      verifiedCount: 1,
      agent: 'fake-agent',
      model: 'claude-opus-5-5',
    });
    const stored = plan.plan as { verification: { downgraded: unknown[] }; assumptions: string[] };
    expect(stored.verification.downgraded).toHaveLength(1);
    expect(stored.assumptions[0]).toMatch(/Unverified finding/);
    expect(plan.assumptionCount).toBe(1);

    // The agent got a read-only token for exactly this repository, and the exact baseline.
    expect(agent.calls[0]).toMatchObject({
      baselineSha: HEAD,
      repository: {
        fullName: REPO.fullName,
        cloneUrl: 'https://github.example/eraqaty/evolvesales.git',
      },
      maxBudgetUsd: 5,
    });
    const tokenRequests = github.tokenRequests();
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]?.path).toBe('/app/installations/4242/access_tokens');
    expect(tokenRequests[0]?.body).toEqual({
      repositories: ['evolvesales'],
      permissions: { contents: 'read', metadata: 'read' },
    });

    const job = after.jobs[0]!;
    expect(job).toMatchObject({
      status: 'SUCCEEDED',
      agentKind: 'fake-agent',
      inputTokens: 1200,
      outputTokens: 300,
      imageDigest: 'sha256:abc',
    });
    expect(job.costUsd?.toString()).toBe('0.4321');
    expect(job.budgetUsd?.toString()).toBe('5');
    const log = job.logs.map((l) => l.message).join('\n');
    expect(log).toContain('Read README.md');
    expect(log).toContain(`baseline: eraqaty/evolvesales@main = ${HEAD}`);
    expect(log).toMatch(/plan verified: 1 verified finding\(s\), 1 downgraded/);
    expect(log).not.toMatch(/ghs_fake/);
    expect(log).toContain('[redacted-github-token]');
    expect(after.transitions.map((t) => t.to)).toEqual([
      'SUBMITTED',
      'ANALYZING',
      'AWAITING_APPROVAL',
    ]);
  });

  it('sends the request to clarification when the agent has blocking questions', async () => {
    await setCaps('5', '20');
    await authorizeRepo();
    const cr = await submittedRequest();
    agent.next = (req) =>
      ({
        ...new FakeAgent().next(req),
        plan: goodPlan({ blockingQuestions: ['Excel or CSV?'] }),
      }) as AnalysisOutcome;

    expect(await handler.handle({ changeRequestId: cr.id, trigger: 'submitted' }, null)).toBe(
      'clarification-required',
    );
    const after = await detail(cr.id);
    expect(after.status).toBe('CLARIFICATION_REQUIRED');
    expect(after.pendingQuestions).toEqual(['Excel or CSV?']);
    expect(after.plans).toHaveLength(1);
  });

  it('refuses to start while the spend caps are not set (no defaults)', async () => {
    await authorizeRepo();
    const cr = await submittedRequest();

    expect(await handler.handle({ changeRequestId: cr.id, trigger: 'submitted' }, null)).toBe(
      'failed',
    );
    const after = await detail(cr.id);
    expect(after.status).toBe('FAILED');
    expect(after.transitions.at(-1)?.reason).toMatch(/spend caps are not set/);
    expect(agent.calls).toHaveLength(0);
    expect(github.tokenRequests()).toHaveLength(0);
  });

  it('refuses when today’s spend plus the job cap would pass the daily cap', async () => {
    await setCaps('5', '20');
    await authorizeRepo();
    const earlier = await submittedRequest();
    await prisma.agentJob.create({
      data: {
        changeRequestId: earlier.id,
        type: 'ANALYZE',
        status: 'SUCCEEDED',
        startedAt: new Date(),
        costUsd: '15.5',
      },
    });
    const cr = await submittedRequest();

    expect(await handler.handle({ changeRequestId: cr.id, trigger: 'submitted' }, null)).toBe(
      'failed',
    );
    expect((await detail(cr.id)).transitions.at(-1)?.reason).toMatch(
      /Daily agent budget reached: 15.50 of 20.00/,
    );
    expect(agent.calls).toHaveLength(0);
  });

  it('refuses without exactly one authorized repository', async () => {
    await setCaps('5', '20');
    const cr = await submittedRequest();
    expect(await handler.handle({ changeRequestId: cr.id, trigger: 'submitted' }, null)).toBe(
      'failed',
    );
    expect((await detail(cr.id)).transitions.at(-1)?.reason).toMatch(/No authorized repository/);
  });

  it('fails visibly when the GitHub App is not configured', async () => {
    const config = new OrchestratorConfig(
      orchestratorEnvSchema.parse({ DATABASE_URL: inject('databaseUrl') }),
    );
    const bare = new AnalyzeHandler(prisma as PrismaService, agent, new GitHubAppService(config));
    const cr = await submittedRequest();
    expect(await bare.handle({ changeRequestId: cr.id, trigger: 'submitted' }, null)).toBe(
      'failed',
    );
    expect((await detail(cr.id)).transitions.at(-1)?.reason).toMatch(/GitHub App not configured/);
  });

  it('discards a plan that does not match the schema, keeping the cost', async () => {
    await setCaps('5', '20');
    await authorizeRepo();
    const cr = await submittedRequest();
    agent.next = (req) =>
      ({ ...new FakeAgent().next(req), plan: { originalRequest: 'only this' } }) as AnalysisOutcome;

    expect(await handler.handle({ changeRequestId: cr.id, trigger: 'submitted' }, null)).toBe(
      'failed',
    );
    const after = await detail(cr.id);
    expect(after.transitions.at(-1)?.reason).toMatch(/does not match the plan schema/);
    expect(after.plans).toHaveLength(0);
    expect(after.jobs[0]).toMatchObject({ status: 'FAILED' });
    expect(after.jobs[0]?.costUsd?.toString()).toBe('0.4321');
  });

  it('discards a plan made from a different commit', async () => {
    await setCaps('5', '20');
    await authorizeRepo();
    const cr = await submittedRequest();
    agent.next = (req) =>
      ({ ...new FakeAgent().next(req), headSha: 'f'.repeat(40) }) as AnalysisOutcome;

    expect(await handler.handle({ changeRequestId: cr.id, trigger: 'submitted' }, null)).toBe(
      'failed',
    );
    expect((await detail(cr.id)).transitions.at(-1)?.reason).toMatch(/not the baseline/);
  });

  it('records a timeout as TIMED_OUT', async () => {
    await setCaps('5', '20');
    await authorizeRepo();
    const cr = await submittedRequest();
    agent.next = () => ({
      ok: false,
      timedOut: true,
      error: 'Analysis timed out after 15 minutes',
      agent: 'fake-agent',
      model: 'claude-opus-5-5',
      usage: null,
      costUsd: null,
      containerId: 'x',
      imageDigest: 'sha256:abc',
    });

    expect(await handler.handle({ changeRequestId: cr.id, trigger: 'submitted' }, null)).toBe(
      'failed',
    );
    const after = await detail(cr.id);
    expect(after.status).toBe('FAILED');
    expect(after.jobs[0]?.status).toBe('TIMED_OUT');
  });

  it('skips a job whose request is no longer SUBMITTED (idempotent)', async () => {
    const cr = await submittedRequest();
    await handler.handle({ changeRequestId: cr.id, trigger: 'submitted' }, 'job-a');
    const again = await handler.handle({ changeRequestId: cr.id, trigger: 'submitted' }, 'job-b');
    expect(again).toBe('skipped');
    expect(await prisma.agentJob.count({ where: { changeRequestId: cr.id } })).toBe(1);
  });

  it('consumes jobs from the pg-boss queue', async () => {
    await setCaps('5', '20');
    await authorizeRepo();
    const cr = await submittedRequest();
    await boss.send(QUEUE.Analyze, { changeRequestId: cr.id, trigger: 'submitted' });

    const deadline = Date.now() + 20_000;
    let status = 'SUBMITTED';
    while (Date.now() < deadline && status !== 'AWAITING_APPROVAL' && status !== 'FAILED') {
      await new Promise((r) => setTimeout(r, 250));
      status = (await prisma.changeRequest.findUniqueOrThrow({ where: { id: cr.id } })).status;
    }
    expect(status).toBe('AWAITING_APPROVAL');
  });

  it('fails jobs left running by a crash (reaper)', async () => {
    const cr = await submittedRequest();
    await prisma.changeRequest.update({ where: { id: cr.id }, data: { status: 'ANALYZING' } });
    await prisma.agentJob.create({
      data: {
        changeRequestId: cr.id,
        type: 'ANALYZE',
        status: 'RUNNING',
        startedAt: new Date(Date.now() - 60_000),
      },
    });

    const result = await app.get(ReaperService).reap(new Date());
    expect(result.jobs).toBe(1);
    const after = await detail(cr.id);
    expect(after.status).toBe('FAILED');
    expect(after.jobs[0]?.status).toBe('FAILED');
    expect(after.jobs[0]?.error).toMatch(/restarted/);
  });

  it('mirrors the installation repositories and de-authorizes removed ones (repo sync)', async () => {
    const sync = app.get(RepoSyncService);
    const other: FakeRepo = { ...REPO, id: 900_000_002, fullName: 'eraqaty/other', private: true };
    github.installations = [{ id: 4242, repos: [REPO, other] }];

    expect(await sync.sync()).toEqual({ seen: 2, removed: 0 });
    const rows = await prisma.repository.findMany({ orderBy: { fullName: 'asc' } });
    expect(
      rows.map((r) => [r.fullName, r.isPrivate, r.isAuthorized, Number(r.installationId)]),
    ).toEqual([
      ['eraqaty/evolvesales', false, false, 4242],
      ['eraqaty/other', true, false, 4242],
    ]);

    await prisma.repository.update({
      where: { fullName: 'eraqaty/other' },
      data: { isAuthorized: true },
    });
    github.installations = [{ id: 4242, repos: [REPO] }];
    expect(await sync.sync()).toEqual({ seen: 1, removed: 1 });
    const removed = await prisma.repository.findUniqueOrThrow({
      where: { fullName: 'eraqaty/other' },
    });
    expect(removed.isAuthorized).toBe(false);
    expect(removed.removedAt).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { action: 'repository.deauthorized' } })).toBe(1);
    github.installations = [{ id: 4242, repos: [REPO] }];
  });
});
