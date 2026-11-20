import type {
  ChangeRequestDetailDto,
  ChangeRequestSummaryDto,
  ConversationDto,
  CrStatus,
  Page,
} from '@evolvesales/shared';
import { recordTransition } from '@evolvesales/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  analyzeJobsFor,
  createTestApp,
  type Fixtures,
  loginAs,
  resetDatabase,
  seedFixtures,
  type TestApp,
} from './helpers.js';
import { sampleProposal, scriptedModel } from './scripted-model.js';

const API = '/api/v1';
type Who = keyof Fixtures['users'];

describe('change requests and approvals (e2e)', () => {
  let t: TestApp;
  let fx: Fixtures;
  let tokens: Record<Who, string>;
  let seq = 0;

  beforeAll(async () => {
    // The scripted model answers the requester's clarification round.
    const { model } = scriptedModel(
      Array.from({ length: 20 }, () => ({
        toolCalls: [
          {
            name: 'propose_change_request',
            input: { ...sampleProposal, assumptions: ['Answered: include drafts'] },
          },
        ],
      })),
    );
    t = await createTestApp({}, { llm: model });
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    fx = await seedFixtures(t.prisma);
    tokens = {
      sales: await loginAs(t, fx.users.sales.email),
      sales2: await loginAs(t, fx.users.sales2.email),
      manager: await loginAs(t, fx.users.manager.email),
      approver: await loginAs(t, fx.users.approver.email),
      admin: await loginAs(t, fx.users.admin.email),
    };
  });

  const http = (who: Who) => ({
    get: (url: string) => t.http().get(`${API}${url}`).auth(tokens[who], { type: 'bearer' }),
    post: (url: string, body: object = {}) =>
      t.http().post(`${API}${url}`).auth(tokens[who], { type: 'bearer' }).send(body),
  });

  /**
   * Test fixture: a request in `status` with a stored plan, created directly in the test
   * database (the analysis agent that produces real plans arrives in Phase 3).
   */
  async function requestIn(status: CrStatus, requester: Who = 'sales'): Promise<string> {
    seq += 1;
    const requesterId = fx.users[requester].id;
    return t.prisma.$transaction(async (tx) => {
      const cr = await tx.changeRequest.create({
        data: {
          key: `CR-${String(9000 + seq)}`,
          title: sampleProposal.title,
          requesterId,
          screen: sampleProposal.screen,
          originalRequest: 'Export please',
          structured: sampleProposal,
          status,
        },
      });
      const plan = await tx.implementationPlan.create({
        data: { changeRequestId: cr.id, version: 1, plan: { fixture: true }, agent: 'test' },
      });
      await tx.changeRequest.update({ where: { id: cr.id }, data: { currentPlanId: plan.id } });
      await recordTransition(tx, cr, null, {
        to: status,
        actor: { type: 'USER', userId: requesterId, roles: ['SALES_USER'] },
      });
      await tx.conversation.create({
        data: {
          userId: requesterId,
          changeRequestId: cr.id,
          screen: sampleProposal.screen,
          status: 'SUBMITTED',
          proposal: sampleProposal,
        },
      });
      return cr.id;
    });
  }

  describe('visibility', () => {
    it('requesters see only their own; approvers and admins see all', async () => {
      const mine = await requestIn('AWAITING_APPROVAL', 'sales');
      await requestIn('AWAITING_APPROVAL', 'sales2');

      const own = (await http('sales').get('/change-requests'))
        .body as Page<ChangeRequestSummaryDto>;
      expect(own.items.map((c) => c.id)).toEqual([mine]);
      const manager = (await http('manager').get('/change-requests'))
        .body as Page<ChangeRequestSummaryDto>;
      expect(manager.total).toBe(0);
      for (const who of ['approver', 'admin'] as const) {
        const all = (await http(who).get('/change-requests')).body as Page<ChangeRequestSummaryDto>;
        expect({ who, total: all.total }).toEqual({ who, total: 2 });
      }
      const mineOnly = (await http('approver').get('/change-requests?mine=true'))
        .body as Page<ChangeRequestSummaryDto>;
      expect(mineOnly.total).toBe(0);
    });

    it('returns 404 for a request the user may not see', async () => {
      const other = await requestIn('AWAITING_APPROVAL', 'sales2');
      expect((await http('sales').get(`/change-requests/${other}`)).status).toBe(404);
      expect((await http('sales2').get(`/change-requests/${other}`)).status).toBe(200);
    });
  });

  describe('approve', () => {
    it('lets an approver approve; records decision, history, audit and notification', async () => {
      const id = await requestIn('AWAITING_APPROVAL');

      const res = await http('approver').post(`/change-requests/${id}/approve`, {
        comment: 'Looks good',
      });

      expect(res.status).toBe(200);
      const dto = res.body as ChangeRequestDetailDto;
      expect(dto.status).toBe('APPROVED');
      expect(dto.decisions).toHaveLength(1);
      expect(dto.decisions[0]).toMatchObject({
        decision: 'APPROVED',
        comment: 'Looks good',
        planVersion: 1,
        actor: { id: fx.users.approver.id },
      });
      expect(dto.transitions.map((x) => x.to)).toEqual(['AWAITING_APPROVAL', 'APPROVED']);
      expect(dto.allowedActions).toEqual([]);

      const audit = await t.prisma.auditLog.findFirstOrThrow({
        where: { entityId: id, action: 'change_request.transition', actorId: fx.users.approver.id },
      });
      expect(audit.after).toMatchObject({ status: 'APPROVED', channel: 'WEB' });
      const notes = await t.prisma.notification.findMany({ where: { userId: fx.users.sales.id } });
      expect(notes.map((n) => n.type)).toContain('cr.status_changed');
      // Approval authorizes coding only: no job is queued in Phase 2, and nothing is deployed.
      expect(await analyzeJobsFor(t.prisma, id)).toBe(0);
    });

    it('rejects approval by roles without approval rights', async () => {
      const id = await requestIn('AWAITING_APPROVAL', 'sales2');
      for (const who of ['sales', 'manager'] as const) {
        const res = await http(who).post(`/change-requests/${id}/approve`);
        expect({ who, status: res.status }).toEqual({ who, status: 403 });
      }
      const row = await t.prisma.changeRequest.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe('AWAITING_APPROVAL');
    });

    it('refuses a second decision (stale state → 409)', async () => {
      const id = await requestIn('AWAITING_APPROVAL');
      expect((await http('approver').post(`/change-requests/${id}/approve`)).status).toBe(200);
      expect((await http('admin').post(`/change-requests/${id}/approve`)).status).toBe(409);
      expect(
        (await http('approver').post(`/change-requests/${id}/reject`, { comment: 'no' })).status,
      ).toBe(409);
    });

    it('refuses to approve a request that is not awaiting approval', async () => {
      const id = await requestIn('SUBMITTED');
      expect((await http('approver').post(`/change-requests/${id}/approve`)).status).toBe(409);
    });
  });

  describe('separation of duties', () => {
    it('blocks an approver from approving their own request', async () => {
      const id = await requestIn('AWAITING_APPROVAL', 'approver');
      const res = await http('approver').post(`/change-requests/${id}/approve`);
      expect(res.status).toBe(403);
      const detail = (await http('approver').get(`/change-requests/${id}`))
        .body as ChangeRequestDetailDto;
      expect(detail.allowedActions).not.toContain('approve');
    });

    it('lets an admin self-approve only with an audited override reason', async () => {
      const id = await requestIn('AWAITING_APPROVAL', 'admin');
      expect((await http('admin').post(`/change-requests/${id}/approve`)).status).toBe(422);

      const res = await http('admin').post(`/change-requests/${id}/approve`, {
        overrideReason: 'Only admin available for the demo',
      });
      expect(res.status).toBe(200);
      const decision = await t.prisma.approvalDecision.findFirstOrThrow({
        where: { changeRequestId: id },
      });
      expect(decision.overrideReason).toBe('Only admin available for the demo');
      expect(
        await t.prisma.auditLog.count({
          where: { entityId: id, action: 'change_request.self_approval_override' },
        }),
      ).toBe(1);
    });
  });

  describe('reject and clarify', () => {
    it('requires a reject comment', async () => {
      const id = await requestIn('AWAITING_APPROVAL');
      expect((await http('approver').post(`/change-requests/${id}/reject`, {})).status).toBe(400);
      const res = await http('approver').post(`/change-requests/${id}/reject`, {
        comment: 'Out of scope for this quarter',
      });
      expect(res.status).toBe(200);
      expect((res.body as ChangeRequestDetailDto).status).toBe('REJECTED');
    });

    it('round-trips a clarification through the requester’s assistant', async () => {
      const id = await requestIn('AWAITING_APPROVAL');

      const clarify = await http('approver').post(`/change-requests/${id}/clarify`, {
        questions: ['Should drafts be included?'],
      });
      expect(clarify.status).toBe(200);
      const detail = clarify.body as ChangeRequestDetailDto;
      expect(detail.status).toBe('CLARIFICATION_REQUIRED');
      expect(detail.pendingQuestions).toEqual(['Should drafts be included?']);

      // Only the requester may answer.
      expect(detail.allowedActions).toEqual([]);
      const own = (await http('sales').get(`/change-requests/${id}`))
        .body as ChangeRequestDetailDto;
      expect(own.allowedActions).toEqual(['answer']);

      // Re-opening returns the request's existing thread, with the questions in it.
      const conv = (
        await http('sales').post('/assistant/conversations', {
          screenContext: { screen: 'change-requests', route: `/requests/${id}` },
          changeRequestId: id,
        })
      ).body as ConversationDto;
      expect(conv.changeRequestId).toBe(id);
      expect(conv.messages.at(-1)?.content).toMatch(/Should drafts be included/);
      expect(
        (
          await http('sales2').post('/assistant/conversations', {
            screenContext: { screen: 'change-requests', route: '/x' },
            changeRequestId: id,
          })
        ).status,
      ).toBe(404);

      const reply = await http('sales').post(`/assistant/conversations/${conv.id}/messages`, {
        content: 'Yes, include drafts',
      });
      expect(reply.status).toBe(200);

      const resubmit = await http('sales').post(`/assistant/conversations/${conv.id}/submit`);
      expect(resubmit.status).toBe(201);
      const after = (await http('sales').get(`/change-requests/${id}`))
        .body as ChangeRequestDetailDto;
      expect(after.status).toBe('SUBMITTED');
      expect(after.pendingQuestions).toEqual([]);
      expect(after.structured.assumptions).toEqual(['Answered: include drafts']);
      expect(after.transitions.map((x) => x.to)).toEqual([
        'AWAITING_APPROVAL',
        'CLARIFICATION_REQUIRED',
        'SUBMITTED',
      ]);
      expect(await analyzeJobsFor(t.prisma, id)).toBe(1);
    });
  });

  describe('retry', () => {
    it('is admin-only and re-queues analysis', async () => {
      const id = await requestIn('FAILED');
      expect(
        (
          await http('approver').post(`/change-requests/${id}/retry`, {
            mode: 'reanalyze',
            reason: 'try again',
          })
        ).status,
      ).toBe(403);

      const res = await http('admin').post(`/change-requests/${id}/retry`, {
        mode: 'reanalyze',
        reason: 'Transient failure',
      });
      expect(res.status).toBe(200);
      expect((res.body as ChangeRequestDetailDto).status).toBe('SUBMITTED');
      expect(await analyzeJobsFor(t.prisma, id)).toBe(1);
    });
  });

  it('keeps status history append-only at the database level', async () => {
    const id = await requestIn('AWAITING_APPROVAL');
    await expect(
      t.prisma.$executeRawUnsafe(
        `UPDATE status_transitions SET reason = 'tampered' WHERE change_request_id = $1::uuid`,
        id,
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      t.prisma.$executeRawUnsafe(
        `DELETE FROM status_transitions WHERE change_request_id = $1::uuid`,
        id,
      ),
    ).rejects.toThrow(/append-only/);
  });
});
