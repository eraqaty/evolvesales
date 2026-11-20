import type { AssistantStreamEvent, ConversationDto } from '@evolvesales/shared';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  analyzeJobsFor,
  createTestApp,
  type Fixtures,
  loginAs,
  parseSse,
  resetDatabase,
  seedFixtures,
  type TestApp,
} from './helpers.js';
import { sampleProposal, type ScriptedStep, scriptedModel } from './scripted-model.js';

const API = '/api/v1';
const screenContext = {
  screen: 'sales.invoices.list',
  route: '/invoices',
  filters: { status: 'DRAFT' },
};

describe('assistant without an LLM key', () => {
  let t: TestApp;
  afterAll(async () => {
    await t.close();
  });

  it('reports not configured and refuses to answer with 503 (no fake replies)', async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    const fx = await seedFixtures(t.prisma);
    const token = await loginAs(t, fx.users.sales.email);

    const status = await t.http().get(`${API}/assistant/status`).auth(token, { type: 'bearer' });
    expect(status.body).toMatchObject({ configured: false, provider: 'anthropic' });

    const conv = await t
      .http()
      .post(`${API}/assistant/conversations`)
      .auth(token, { type: 'bearer' })
      .send({ screenContext });
    expect(conv.status).toBe(201);

    const res = await t
      .http()
      .post(`${API}/assistant/conversations/${(conv.body as ConversationDto).id}/messages`)
      .auth(token, { type: 'bearer' })
      .send({ content: 'hello' });
    expect(res.status).toBe(503);
    expect(String((res.body as { message: string }).message)).toMatch(/ANTHROPIC_API_KEY/);
    // The user message is not stored when nothing can answer it.
    expect(await t.prisma.conversationMessage.count()).toBe(0);
  });
});

describe('assistant with a scripted model (e2e)', () => {
  let t: TestApp;
  let fx: Fixtures;
  let token: string;
  let calls: ReturnType<typeof scriptedModel>['calls'];

  async function start(steps: ScriptedStep[]) {
    const scripted = scriptedModel(steps);
    calls = scripted.calls;
    t = await createTestApp({}, { llm: scripted.model });
    await resetDatabase(t.prisma);
    fx = await seedFixtures(t.prisma);
    token = await loginAs(t, fx.users.sales.email);
  }
  afterEach(async () => {
    await t?.close();
  });

  const newConversation = async (as = token) => {
    const res = await t
      .http()
      .post(`${API}/assistant/conversations`)
      .auth(as, { type: 'bearer' })
      .send({ screenContext });
    expect(res.status).toBe(201);
    return res.body as ConversationDto;
  };
  const send = async (id: string, content: string, as = token) =>
    t
      .http()
      .post(`${API}/assistant/conversations/${id}/messages`)
      .auth(as, { type: 'bearer' })
      .send({ content });

  it('streams text and a validated proposal, then persists both', async () => {
    await start([
      { toolCalls: [{ name: 'propose_change_request', input: sampleProposal }] },
      { text: 'Please review the summary and press Submit request.' },
    ]);
    const conv = await newConversation();

    const res = await send(conv.id, 'I need to export the invoice list to Excel');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    const events = parseSse<AssistantStreamEvent>(res.text);
    expect(events.map((e) => e.type)).toEqual(['tool', 'proposal', 'text', 'done']);
    expect(events[1]).toMatchObject({ proposal: { title: sampleProposal.title } });

    const saved = await t
      .http()
      .get(`${API}/assistant/conversations/${conv.id}`)
      .auth(token, { type: 'bearer' });
    const dto = saved.body as ConversationDto;
    expect(dto.proposal?.title).toBe(sampleProposal.title);
    expect(dto.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(dto.messages[1]?.content).toMatch(/press Submit/);

    // The screen context reached the model only as delimited data in the system prompt.
    const system = calls[0]?.prompt.find((m) => m.role === 'system');
    expect(JSON.stringify(system)).toContain('<data name=\\"screen_context\\">');
  });

  it('rejects an invalid proposal from the model instead of storing it', async () => {
    await start([
      { toolCalls: [{ name: 'propose_change_request', input: { title: 'x' } }] },
      { text: 'Sorry, let me ask more.' },
    ]);
    const conv = await newConversation();

    const res = await send(conv.id, 'make it better');

    const events = parseSse<AssistantStreamEvent>(res.text);
    expect(events.some((e) => e.type === 'proposal')).toBe(false);
    const row = await t.prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } });
    expect(row.proposal).toBeNull();
  });

  it('answers data questions through audited read-only tools', async () => {
    await start([
      { toolCalls: [{ name: 'findInvoices', input: { status: 'DRAFT' } }] },
      { text: 'You have no draft invoices.' },
    ]);
    const conv = await newConversation();

    const res = await send(conv.id, 'How many draft invoices do I have?');

    expect(parseSse<AssistantStreamEvent>(res.text).map((e) => e.type)).toEqual([
      'tool',
      'text',
      'done',
    ]);
    const audit = await t.prisma.auditLog.findFirstOrThrow({
      where: { action: 'assistant.data_query' },
    });
    expect(audit.actorId).toBe(fx.users.sales.id);
    expect(audit.after).toMatchObject({ tool: 'findInvoices', args: { status: 'DRAFT' } });
    // The tool result was fed back to the model as a tool message.
    expect(calls[1]?.prompt.some((m) => m.role === 'tool')).toBe(true);
  });

  it('submits the proposal as a change request and enqueues analysis', async () => {
    await start([{ toolCalls: [{ name: 'propose_change_request', input: sampleProposal }] }]);
    const conv = await newConversation();
    await send(conv.id, 'Export to Excel please');

    const res = await t
      .http()
      .post(`${API}/assistant/conversations/${conv.id}/submit`)
      .auth(token, { type: 'bearer' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ key: 'CR-0001', status: 'SUBMITTED' });
    const id = (res.body as { changeRequestId: string }).changeRequestId;
    const cr = await t.prisma.changeRequest.findUniqueOrThrow({
      where: { id },
      include: { transitions: true },
    });
    expect(cr).toMatchObject({
      requesterId: fx.users.sales.id,
      title: sampleProposal.title,
      originalRequest: 'Export to Excel please',
    });
    expect(cr.transitions.map((x) => [x.from, x.to])).toEqual([[null, 'SUBMITTED']]);
    expect(await analyzeJobsFor(t.prisma, id)).toBe(1);
    expect(
      await t.prisma.auditLog.count({ where: { entityId: id, action: 'assistant.submitted' } }),
    ).toBe(1);

    // Submitting twice is refused; the conversation is closed for new messages.
    const again = await t
      .http()
      .post(`${API}/assistant/conversations/${conv.id}/submit`)
      .auth(token, { type: 'bearer' });
    expect(again.status).toBe(409);
    expect((await send(conv.id, 'one more thing')).status).toBe(409);
  });

  it('refuses to submit without a proposal, and hides other users’ conversations', async () => {
    await start([]);
    const conv = await newConversation();

    const submit = await t
      .http()
      .post(`${API}/assistant/conversations/${conv.id}/submit`)
      .auth(token, { type: 'bearer' });
    expect(submit.status).toBe(422);

    const other = await loginAs(t, fx.users.sales2.email);
    expect(
      (
        await t
          .http()
          .get(`${API}/assistant/conversations/${conv.id}`)
          .auth(other, { type: 'bearer' })
      ).status,
    ).toBe(404);
    expect((await send(conv.id, 'hi', other)).status).toBe(404);
  });

  it('enforces the message length and per-conversation limits', async () => {
    await start([]);
    const conv = await newConversation();

    expect((await send(conv.id, 'x'.repeat(4001))).status).toBe(400);

    await t.prisma.conversationMessage.createMany({
      data: Array.from({ length: 20 }, (_, i) => ({
        conversationId: conv.id,
        role: 'user' as const,
        content: `m${i}`,
      })),
    });
    expect((await send(conv.id, 'one too many')).status).toBe(422);
  });
});
