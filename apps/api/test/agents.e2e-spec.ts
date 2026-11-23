import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestApp,
  type Fixtures,
  loginAs,
  resetDatabase,
  seedFixtures,
  type TestApp,
} from './helpers.js';
import { sampleProposal } from './scripted-model.js';

const API = '/api/v1';
type Who = 'sales' | 'sales2' | 'approver' | 'admin';

describe('agent administration and job logs (e2e)', () => {
  let t: TestApp;
  let fx: Fixtures;
  const tokens = {} as Record<Who, string>;

  const http = (who: Who) => ({
    get: (url: string) => t.http().get(`${API}${url}`).auth(tokens[who], { type: 'bearer' }),
    put: (url: string, body: object) =>
      t.http().put(`${API}${url}`).auth(tokens[who], { type: 'bearer' }).send(body),
    post: (url: string, body: object = {}) =>
      t.http().post(`${API}${url}`).auth(tokens[who], { type: 'bearer' }).send(body),
  });

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    fx = await seedFixtures(t.prisma);
    for (const who of ['sales', 'sales2', 'approver', 'admin'] as const) {
      tokens[who] = await loginAs(t, fx.users[who].email);
    }
  });

  const repo = (fullName: string, extra: object = {}) =>
    t.prisma.repository.create({
      data: {
        githubId: BigInt(Math.floor(Math.random() * 1e9)),
        fullName,
        installationId: 77n,
        defaultBranch: 'main',
        lastSyncedAt: new Date(),
        ...extra,
      },
    });

  describe('spend caps', () => {
    it('starts unset (no defaults) and only admins can see or change them', async () => {
      const res = await http('admin').get('/admin/agent-settings');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        analyzeMaxBudgetUsd: null,
        dailyBudgetUsd: null,
        spentTodayUsd: '0.00',
        updatedAt: null,
        updatedBy: null,
      });
      expect((await http('approver').get('/admin/agent-settings')).status).toBe(403);
      expect(
        (
          await http('sales').put('/admin/agent-settings', {
            analyzeMaxBudgetUsd: 5,
            dailyBudgetUsd: 20,
          })
        ).status,
      ).toBe(403);
    });

    it('validates, stores and audits the caps', async () => {
      for (const bad of [
        { analyzeMaxBudgetUsd: 0, dailyBudgetUsd: 20 },
        { analyzeMaxBudgetUsd: 10, dailyBudgetUsd: 5 },
        { analyzeMaxBudgetUsd: 101, dailyBudgetUsd: 500 },
        { analyzeMaxBudgetUsd: 5 },
        { analyzeMaxBudgetUsd: 5, dailyBudgetUsd: 20, extra: true },
      ]) {
        const status = (await http('admin').put('/admin/agent-settings', bad)).status;
        expect([bad, status]).toEqual([bad, 400]);
      }
      const res = await http('admin').put('/admin/agent-settings', {
        analyzeMaxBudgetUsd: '5',
        dailyBudgetUsd: 20.5,
      });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        analyzeMaxBudgetUsd: '5.00',
        dailyBudgetUsd: '20.50',
        updatedBy: { id: fx.users.admin.id },
      });
      const audit = await t.prisma.auditLog.findFirst({
        where: { action: 'agent_settings.updated' },
      });
      expect(audit).toMatchObject({ actorId: fx.users.admin.id });
    });

    it('reports today’s spend', async () => {
      const cr = await t.prisma.changeRequest.create({
        data: {
          key: 'CR-0100',
          title: 't',
          requesterId: fx.users.sales.id,
          screen: 's',
          originalRequest: 'x',
          structured: sampleProposal,
          status: 'FAILED',
        },
      });
      await t.prisma.agentJob.createMany({
        data: [
          {
            changeRequestId: cr.id,
            type: 'ANALYZE',
            status: 'SUCCEEDED',
            startedAt: new Date(),
            costUsd: '1.2345',
          },
          {
            changeRequestId: cr.id,
            type: 'ANALYZE',
            status: 'FAILED',
            startedAt: new Date(),
            costUsd: '0.5',
          },
          {
            changeRequestId: cr.id,
            type: 'ANALYZE',
            status: 'FAILED',
            startedAt: new Date('2020-01-01'),
            costUsd: '99',
          },
        ],
      });
      expect((await http('admin').get('/admin/agent-settings')).body).toMatchObject({
        spentTodayUsd: '1.73',
      });
    });
  });

  describe('repositories', () => {
    it('lists repositories for admins only', async () => {
      await repo('eraqaty/evolvesales');
      const res = await http('admin').get('/admin/repositories');
      expect(res.status).toBe(200);
      expect(res.body).toEqual([
        expect.objectContaining({
          fullName: 'eraqaty/evolvesales',
          isAuthorized: false,
          removedAt: null,
        }),
      ]);
      expect(JSON.stringify(res.body)).not.toContain('installation');
      expect((await http('approver').get('/admin/repositories')).status).toBe(403);
    });

    it('authorizes one repository at a time, never a removed one, and audits it', async () => {
      const a = await repo('eraqaty/evolvesales');
      const b = await repo('eraqaty/other');
      const gone = await repo('eraqaty/gone', { removedAt: new Date() });

      const ok = await http('admin').put(`/admin/repositories/${a.id}/authorization`, {
        authorized: true,
      });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({
        isAuthorized: true,
        authorizedBy: { id: fx.users.admin.id },
      });

      const second = await http('admin').put(`/admin/repositories/${b.id}/authorization`, {
        authorized: true,
      });
      expect(second.status).toBe(409);
      expect(
        (
          await http('admin').put(`/admin/repositories/${gone.id}/authorization`, {
            authorized: true,
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await http('approver').put(`/admin/repositories/${b.id}/authorization`, {
            authorized: true,
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await http('admin').put(`/admin/repositories/${b.id}/authorization`, {
            authorized: 'yes',
          })
        ).status,
      ).toBe(400);

      const revoke = await http('admin').put(`/admin/repositories/${a.id}/authorization`, {
        authorized: false,
      });
      expect(revoke.body).toMatchObject({ isAuthorized: false, authorizedBy: null });
      expect(
        (await http('admin').put(`/admin/repositories/${b.id}/authorization`, { authorized: true }))
          .status,
      ).toBe(200);

      const actions = (
        await t.prisma.auditLog.findMany({
          where: { entityType: 'Repository' },
          orderBy: { id: 'asc' },
        })
      ).map((l) => l.action);
      expect(actions).toEqual([
        'repository.authorized',
        'repository.deauthorized',
        'repository.authorized',
      ]);
    });

    it('queues a sync for the Orchestrator instead of calling GitHub', async () => {
      const res = await http('admin').post('/admin/repositories/sync');
      expect(res.status).toBe(202);
      const jobs = await t.prisma.$queryRawUnsafe<Array<{ data: { requestedById: string } }>>(
        `SELECT data FROM pgboss.job WHERE name = 'github-repo-sync'`,
      );
      expect(jobs).toEqual([{ data: { requestedById: fx.users.admin.id } }]);
      expect((await http('approver').post('/admin/repositories/sync')).status).toBe(403);
    });
  });

  describe('job logs', () => {
    async function jobWithLogs() {
      const cr = await t.prisma.changeRequest.create({
        data: {
          key: 'CR-0200',
          title: 't',
          requesterId: fx.users.sales.id,
          screen: 's',
          originalRequest: 'x',
          structured: sampleProposal,
          status: 'ANALYZING',
        },
      });
      const job = await t.prisma.agentJob.create({
        data: { changeRequestId: cr.id, type: 'ANALYZE', status: 'RUNNING', startedAt: new Date() },
      });
      await t.prisma.jobLog.createMany({
        data: [0, 1, 2].map((seq) => ({
          agentJobId: job.id,
          seq,
          source: 'agent',
          message: `line ${seq}`,
        })),
      });
      return { crId: cr.id, jobId: job.id };
    }

    it('shows the log to the requester and approvers, paged by sequence', async () => {
      const { crId, jobId } = await jobWithLogs();
      const all = await http('sales').get(`/change-requests/${crId}/jobs/${jobId}/logs`);
      expect(all.status).toBe(200);
      expect(all.body).toMatchObject({ jobId, status: 'RUNNING', lastSeq: 2 });
      expect(
        (all.body as { lines: Array<{ message: string }> }).lines.map((l) => l.message),
      ).toEqual(['line 0', 'line 1', 'line 2']);

      const newer = await http('approver').get(
        `/change-requests/${crId}/jobs/${jobId}/logs?after=1`,
      );
      expect(newer.body).toMatchObject({ lines: [{ seq: 2 }], lastSeq: 2 });
      const none = await http('admin').get(`/change-requests/${crId}/jobs/${jobId}/logs?after=2`);
      expect(none.body).toMatchObject({ lines: [], lastSeq: 2 });
    });

    it('hides the log from other users and from mismatched ids (404)', async () => {
      const { crId, jobId } = await jobWithLogs();
      expect((await http('sales2').get(`/change-requests/${crId}/jobs/${jobId}/logs`)).status).toBe(
        404,
      );
      const other = await t.prisma.changeRequest.create({
        data: {
          key: 'CR-0201',
          title: 't',
          requesterId: fx.users.sales2.id,
          screen: 's',
          originalRequest: 'x',
          structured: sampleProposal,
          status: 'FAILED',
        },
      });
      expect(
        (await http('sales2').get(`/change-requests/${other.id}/jobs/${jobId}/logs`)).status,
      ).toBe(404);
      expect(
        (await http('sales').get(`/change-requests/${crId}/jobs/not-a-uuid/logs`)).status,
      ).toBe(400);
      expect(
        (await http('sales').get(`/change-requests/${crId}/jobs/${jobId}/logs?limit=5000`)).status,
      ).toBe(400);
    });

    it('includes the job cost on the request detail', async () => {
      const { crId, jobId } = await jobWithLogs();
      await t.prisma.agentJob.update({ where: { id: jobId }, data: { costUsd: '0.1234' } });
      const detail = await http('sales').get(`/change-requests/${crId}`);
      expect(detail.body).toMatchObject({ jobs: [{ id: jobId, costUsd: '0.1234' }] });
    });
  });
});
