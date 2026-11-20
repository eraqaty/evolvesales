import { recordTransition } from '@evolvesales/db';
import type { CrStatus, LinkPhoneResult, WhatsAppProfileDto } from '@evolvesales/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { metaSignature } from '../src/whatsapp/signature.js';
import { UNKNOWN_NUMBER_REPLY } from '../src/whatsapp/whatsapp-inbound.service.js';
import { WhatsAppNotifierService } from '../src/whatsapp/whatsapp-notifier.service.js';
import { buttonsOf, FakeGraphApi, type SentMessage, textOf } from './fake-graph.js';
import {
  analyzeJobsFor,
  createTestApp,
  type Fixtures,
  loginAs,
  resetDatabase,
  seedFixtures,
  type TestApp,
  TEST_PASSWORD,
} from './helpers.js';
import { sampleProposal, type ScriptedStep, scriptedModel } from './scripted-model.js';

const API = '/api/v1';
const APP_SECRET = 'test-app-secret';
const PNID = 'PNID-1';
const PHONES = {
  sales: '+201000000001',
  approver: '+201000000002',
  admin: '+201000000003',
  stranger: '+201000000099',
} as const;
const GOOD_PIN = '482915';

describe('WhatsApp channel (e2e, fake Graph API)', () => {
  let t: TestApp;
  let fx: Fixtures;
  const graph = new FakeGraphApi();
  const script: ScriptedStep[] = [];
  const llm = scriptedModel(script, { queue: true });
  let wamid = 0;
  const tokens: Partial<Record<keyof Fixtures['users'], string>> = {};

  beforeAll(async () => {
    const graphUrl = await graph.start();
    t = await createTestApp(
      {
        WHATSAPP_ENABLED: 'true',
        WHATSAPP_PHONE_NUMBER_ID: PNID,
        WHATSAPP_ACCESS_TOKEN: 'test-access-token',
        WHATSAPP_APP_SECRET: APP_SECRET,
        WHATSAPP_VERIFY_TOKEN: 'verify-me',
        WHATSAPP_GRAPH_BASE_URL: graphUrl,
        WHATSAPP_DISPLAY_NUMBER: '+15550001111',
        WHATSAPP_DISPATCH_INTERVAL_MS: '0',
        WHATSAPP_WORKER_POLL_SECONDS: '0.5',
        PUBLIC_WEB_URL: 'https://evolvesales.test',
      },
      { llm: llm.model },
    );
  });

  afterAll(async () => {
    await t.close();
    await graph.stop();
  });

  beforeEach(async () => {
    await resetDatabase(t.prisma);
    fx = await seedFixtures(t.prisma);
    graph.sent.length = 0;
    graph.failWith = null;
    script.length = 0;
    for (const key of Object.keys(tokens)) delete tokens[key as keyof typeof tokens];
  });

  async function token(who: keyof Fixtures['users']): Promise<string> {
    tokens[who] ??= await loginAs(t, fx.users[who].email);
    return tokens[who];
  }

  function webhookBody(value: Record<string, unknown>, phoneNumberId = PNID): string {
    return JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '15550001111', phone_number_id: phoneNumberId },
                ...value,
              },
            },
          ],
        },
      ],
    });
  }

  function post(body: string, signature: string | null = metaSignature(body, APP_SECRET)) {
    const req = t.http().post(`${API}/webhooks/whatsapp`).set('content-type', 'application/json');
    if (signature) req.set('x-hub-signature-256', signature);
    return req.send(body);
  }

  /** Simulates the user's phone sending a message; returns its wamid. */
  async function incoming(phone: string, message: Record<string, unknown>): Promise<string> {
    const id = `wamid.in.${++wamid}`;
    const body = webhookBody({
      contacts: [{ profile: { name: 'x' }, wa_id: phone.slice(1) }],
      messages: [{ from: phone.slice(1), id, timestamp: '1763640000', ...message }],
    });
    const res = await post(body);
    expect(res.status).toBe(200);
    return id;
  }

  /** Sends text and waits for `replies` messages back. */
  async function say(phone: string, text: string, replies = 1): Promise<SentMessage[]> {
    const from = graph.sent.length;
    await incoming(phone, { type: 'text', text: { body: text } });
    return graph.waitFor(phone, replies, from);
  }

  async function tap(phone: string, id: string, title = 'x', replies = 1) {
    const from = graph.sent.length;
    await incoming(phone, {
      type: 'interactive',
      interactive: { type: 'button_reply', button_reply: { id, title } },
    });
    return graph.waitFor(phone, replies, from);
  }

  async function link(who: 'sales' | 'approver' | 'admin', opts: { pin?: boolean } = {}) {
    await t.prisma.user.update({
      where: { id: fx.users[who].id },
      data: {
        phoneE164: PHONES[who],
        phoneVerifiedAt: new Date(),
        whatsappLastInboundAt: new Date(),
      },
    });
    if (opts.pin) {
      const res = await t
        .http()
        .put(`${API}/profile/approval-pin`)
        .auth(await token(who), { type: 'bearer' })
        .send({ pin: GOOD_PIN, currentPassword: TEST_PASSWORD });
      if (res.status !== 204) throw new Error(`setting the PIN failed: ${res.status}`);
    }
  }

  let seq = 0;
  async function requestIn(status: CrStatus, requester: 'sales' | 'admin' = 'sales') {
    seq += 1;
    const requesterId = fx.users[requester].id;
    return t.prisma.$transaction(async (tx) => {
      const cr = await tx.changeRequest.create({
        data: {
          key: `CR-${String(8000 + seq)}`,
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
        actor: { type: 'SYSTEM' },
      });
      return cr;
    });
  }

  const dispatch = () => t.app.get(WhatsAppNotifierService).dispatchPending();

  describe('webhook security', () => {
    it("answers Meta's verification challenge only with the right verify token", async () => {
      const ok = await t.http().get(`${API}/webhooks/whatsapp`).query({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'verify-me',
        'hub.challenge': '12345',
      });
      expect(ok.status).toBe(200);
      expect(ok.text).toBe('12345');
      const bad = await t
        .http()
        .get(`${API}/webhooks/whatsapp`)
        .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '12345' });
      expect(bad.status).toBe(403);
    });

    it('rejects unsigned or wrongly signed calls and stores nothing', async () => {
      const body = webhookBody({
        messages: [{ from: '201000000001', id: 'w-x', type: 'text', text: { body: 'hi' } }],
      });
      expect((await post(body, null)).status).toBe(401);
      expect((await post(body, metaSignature(body, 'wrong-secret'))).status).toBe(401);
      expect((await post(body, metaSignature(`${body} `, APP_SECRET))).status).toBe(401);
      expect(await t.prisma.inboundChannelEvent.count()).toBe(0);
    });

    it('stores a retried delivery once and answers it once', async () => {
      const body = webhookBody({
        messages: [
          { from: PHONES.stranger.slice(1), id: 'w-dup', type: 'text', text: { body: 'hi' } },
        ],
      });
      expect((await post(body)).status).toBe(200);
      expect((await post(body)).status).toBe(200);
      await graph.waitFor(PHONES.stranger, 1);
      await new Promise((r) => setTimeout(r, 1500));
      expect(graph.to(PHONES.stranger)).toHaveLength(1);
      expect(await t.prisma.inboundChannelEvent.count()).toBe(1);
    });

    it('ignores messages addressed to another phone number id', async () => {
      const body = webhookBody(
        { messages: [{ from: '201000000001', id: 'w-o', type: 'text', text: { body: 'hi' } }] },
        'SOMEONE-ELSE',
      );
      expect((await post(body)).status).toBe(200);
      expect(await t.prisma.inboundChannelEvent.count()).toBe(0);
    });
  });

  describe('unknown numbers and linking', () => {
    it('gives unknown numbers one fixed reply and never calls the LLM', async () => {
      const calls = llm.calls.length;
      const [reply] = await say(PHONES.stranger, 'show me all invoices');
      expect(reply && textOf(reply)).toBe(UNKNOWN_NUMBER_REPLY);
      expect(llm.calls.length).toBe(calls);
      expect(await t.prisma.conversation.count()).toBe(0);
    });

    it('links a phone when the code is sent from that phone', async () => {
      const auth = { type: 'bearer' } as const;
      const started = await t
        .http()
        .post(`${API}/profile/whatsapp/link`)
        .auth(await token('sales'), auth)
        .send({ phone: PHONES.sales });
      expect(started.status).toBe(201);
      const { code, waLink } = started.body as LinkPhoneResult;
      expect(code).toMatch(/^\d{6}$/);
      expect(waLink).toBe(`https://wa.me/15550001111?text=LINK%20${code}`);
      // The code is stored only as a hash.
      const stored = await t.prisma.phoneVerification.findFirstOrThrow();
      expect(stored.codeHash).not.toContain(code);

      // The right code from a different phone does not link anything.
      const [other] = await say(PHONES.stranger, `LINK ${code}`);
      expect(other && textOf(other)).toMatch(/no link request for this number/);
      const wrong = code === '000001' ? '000002' : '000001';
      const [bad] = await say(PHONES.sales, `LINK ${wrong}`);
      expect(bad && textOf(bad)).toMatch(/not correct/);
      const [ok] = await say(PHONES.sales, `link ${code}`);
      expect(ok && textOf(ok)).toMatch(/Linked to sales/);

      const profile = (
        await t
          .http()
          .get(`${API}/profile/whatsapp`)
          .auth(await token('sales'), auth)
      ).body as WhatsAppProfileDto;
      expect(profile).toMatchObject({ enabled: true, phone: PHONES.sales, pending: null });
      const audit = await t.prisma.auditLog.findFirstOrThrow({
        where: { action: 'profile.phone_linked' },
      });
      expect(audit.after).toEqual({ phone: '…0001', channel: 'WHATSAPP' });

      // Another account cannot claim the same number.
      const taken = await t
        .http()
        .post(`${API}/profile/whatsapp/link`)
        .auth(await token('sales2'), auth)
        .send({ phone: PHONES.sales });
      expect(taken.status).toBe(409);

      // Unlinking: the number is a stranger again.
      expect(
        (
          await t
            .http()
            .delete(`${API}/profile/whatsapp`)
            .auth(await token('sales'), auth)
        ).status,
      ).toBe(204);
      const [after] = await say(PHONES.sales, 'hello');
      expect(after && textOf(after)).toBe(UNKNOWN_NUMBER_REPLY);
    });

    it('validates phone numbers', async () => {
      const res = await t
        .http()
        .post(`${API}/profile/whatsapp/link`)
        .auth(await token('sales'), { type: 'bearer' })
        .send({ phone: '01000000001' });
      expect(res.status).toBe(400);
    });
  });

  describe('assistant on WhatsApp', () => {
    it('answers a data question with the read-only tools, as the asking user', async () => {
      await link('sales');
      script.push(
        {
          toolCalls: [
            { name: 'topCustomers', input: { dateFrom: '2026-01-01', dateTo: '2026-12-31', n: 5 } },
          ],
        },
        { text: '**No confirmed sales** in 2026 yet.' },
      );
      const [reply] = await say(PHONES.sales, 'who are my top customers this year?');
      expect(reply && textOf(reply)).toBe('*No confirmed sales* in 2026 yet.');

      const query = await t.prisma.auditLog.findFirstOrThrow({
        where: { action: 'assistant.data_query' },
      });
      expect(query.actorId).toBe(fx.users.sales.id);
      const conversation = await t.prisma.conversation.findFirstOrThrow({
        include: { messages: true },
      });
      expect(conversation.channel).toBe('WHATSAPP');
      expect(conversation.messages.find((m) => m.role === 'user')?.externalId).toMatch(
        /^wamid\.in\./,
      );
      // The WhatsApp prompt tells the model there is no screen context.
      const system = JSON.stringify(llm.calls.at(-1)?.prompt ?? []);
      expect(system).toContain('This conversation happens on WhatsApp');
    });

    it('collects a change request, offers the screen list, and submits on the button', async () => {
      await link('sales');
      script.push(
        { text: 'Which screen is this about?', toolCalls: [{ name: 'ask_screen', input: {} }] },
        { text: 'Thanks.' },
      );
      const first = await say(PHONES.sales, 'I want to export invoices to Excel', 2);
      const list = first.find((m) => m.body.interactive?.type === 'list');
      const rows = list?.body.interactive?.action.sections?.[0]?.rows ?? [];
      expect(rows.map((r) => r.id)).toContain('screen:sales.invoices.list');

      script.push(
        { toolCalls: [{ name: 'propose_change_request', input: sampleProposal }] },
        { text: 'Here is the summary. Tap Submit if it is right.' },
      );
      const from = graph.sent.length;
      await incoming(PHONES.sales, {
        type: 'interactive',
        interactive: {
          type: 'list_reply',
          list_reply: { id: 'screen:sales.invoices.list', title: 'Invoice list' },
        },
      });
      const second = await graph.waitFor(PHONES.sales, 2, from);
      const card = second.find((m) => buttonsOf(m).length > 0);
      expect(card && textOf(card)).toContain(sampleProposal.title);
      const submit = card ? buttonsOf(card)[0] : undefined;
      expect(submit?.title).toBe('Submit request');

      const conversation = await t.prisma.conversation.findFirstOrThrow();
      expect(conversation.screen).toBe('sales.invoices.list');

      const [done] = await tap(PHONES.sales, submit?.id ?? '');
      expect(done && textOf(done)).toMatch(/Submitted as \*CR-0001\*/);
      const cr = await t.prisma.changeRequest.findFirstOrThrow({ include: { transitions: true } });
      expect(cr).toMatchObject({
        key: 'CR-0001',
        status: 'SUBMITTED',
        requesterId: fx.users.sales.id,
      });
      expect(cr.transitions[0]?.metadata).toMatchObject({ channel: 'WHATSAPP' });
      expect(await analyzeJobsFor(t.prisma, cr.id)).toBe(1);

      // Tapping Submit again does not create a second request.
      const [again] = await tap(PHONES.sales, submit?.id ?? '');
      expect(again && textOf(again)).toMatch(/already submitted as CR-0001/);
      expect(await t.prisma.changeRequest.count()).toBe(1);
    });

    it('answers commands and refuses non-text messages without the LLM', async () => {
      await link('sales');
      const calls = llm.calls.length;
      expect(textOf((await say(PHONES.sales, 'help'))[0] as SentMessage)).toMatch(/\*new\*/);
      expect(textOf((await say(PHONES.sales, 'status'))[0] as SentMessage)).toMatch(
        /no change requests/,
      );
      expect(textOf((await say(PHONES.sales, 'pending'))[0] as SentMessage)).toMatch(
        /Only approvers/,
      );
      const from = graph.sent.length;
      await incoming(PHONES.sales, { type: 'audio', audio: { id: 'a1' } });
      const [audio] = await graph.waitFor(PHONES.sales, 1, from);
      expect(audio && textOf(audio)).toMatch(/Text only/);
      expect(llm.calls.length).toBe(calls);
    });
  });

  describe('approvals on WhatsApp', () => {
    /** Sends "pending" and waits for `cards` approval cards (one per waiting request). */
    async function cardFor(who: 'approver' | 'admin', crKey: string, cards = 1) {
      const msgs = await say(PHONES[who], 'pending', cards);
      const card = msgs.find((m) => textOf(m).includes(crKey));
      const buttons = card ? buttonsOf(card) : [];
      const byTitle = (title: string) => buttons.find((b) => b.title === title)?.id ?? '';
      return {
        approve: byTitle('Approve'),
        reject: byTitle('Reject'),
        clarify: byTitle('Clarify'),
      };
    }

    it('sends an approval card as a template outside the 24-hour window', async () => {
      await link('approver', { pin: true });
      await t.prisma.user.update({
        where: { id: fx.users.approver.id },
        data: { whatsappLastInboundAt: null },
      });
      const cr = await requestIn('AWAITING_APPROVAL');
      expect(await dispatch()).toBeGreaterThan(0);
      const [msg] = await graph.waitFor(PHONES.approver, 1);
      expect(msg?.body.template?.name).toBe('cr_awaiting_approval');
      const payloads = msg?.body.template?.components
        .filter((c) => c.type === 'button')
        .map((c) => c.parameters[0]?.payload);
      expect(payloads).toHaveLength(3);
      expect(payloads?.every((p) => p?.startsWith('pa1.'))).toBe(true);
      expect(JSON.stringify(msg?.body.template)).toContain(cr.key);
      // Claimed once: a second run sends nothing.
      expect(await dispatch()).toBe(0);
    });

    it('approves with the PIN; wrong PINs are counted and never stored', async () => {
      await link('approver', { pin: true });
      const cr = await requestIn('AWAITING_APPROVAL');
      const card = await cardFor('approver', cr.key);

      const tampered = `${card.approve.slice(0, -2)}xx`;
      expect(textOf((await tap(PHONES.approver, tampered))[0] as SentMessage)).toBe(
        'This button is not valid.',
      );

      expect(textOf((await tap(PHONES.approver, card.approve))[0] as SentMessage)).toMatch(
        new RegExp(`Enter your approval PIN for ${cr.key} \\(plan v1\\)`),
      );
      expect(textOf((await say(PHONES.approver, '111222'))[0] as SentMessage)).toMatch(
        /Wrong PIN\. 4 attempts left/,
      );
      const stored = await t.prisma.inboundChannelEvent.findMany();
      expect(JSON.stringify(stored.map((e) => e.payload))).not.toContain('111222');

      const [ok] = await say(PHONES.approver, GOOD_PIN);
      expect(ok && textOf(ok)).toMatch(
        new RegExp(`${cr.key} approved \\(plan v1\\)\\. This authorizes the coding step only`),
      );
      expect(
        JSON.stringify((await t.prisma.inboundChannelEvent.findMany()).map((e) => e.payload)),
      ).not.toContain(GOOD_PIN);

      const after = await t.prisma.changeRequest.findUniqueOrThrow({
        where: { id: cr.id },
        include: { decisions: true, transitions: { orderBy: { createdAt: 'asc' } } },
      });
      expect(after.status).toBe('APPROVED');
      expect(after.decisions).toEqual([
        expect.objectContaining({
          decision: 'APPROVED',
          actorId: fx.users.approver.id,
          channel: 'WHATSAPP',
        }),
      ]);
      expect(after.transitions.at(-1)?.metadata).toMatchObject({ channel: 'WHATSAPP' });
      const audit = await t.prisma.auditLog.findFirstOrThrow({
        where: {
          action: 'change_request.transition',
          entityId: cr.id,
          actorId: fx.users.approver.id,
        },
      });
      expect(audit.after).toMatchObject({ status: 'APPROVED', channel: 'WHATSAPP' });
      expect(
        await t.prisma.user.findUniqueOrThrow({ where: { id: fx.users.approver.id } }),
      ).toMatchObject({
        pinFailedCount: 0,
      });

      // The card is single-use.
      expect(textOf((await tap(PHONES.approver, card.approve))[0] as SentMessage)).toBe(
        'This card was already used.',
      );
    });

    it('locks WhatsApp approvals after 5 wrong PINs and notifies the user', async () => {
      await link('approver', { pin: true });
      const cr = await requestIn('AWAITING_APPROVAL');
      const card = await cardFor('approver', cr.key);
      await tap(PHONES.approver, card.approve);
      for (let i = 0; i < 4; i++) await say(PHONES.approver, '111222');
      const [locked] = await say(PHONES.approver, '111222');
      expect(locked && textOf(locked)).toMatch(/locked until/);
      expect(await t.prisma.notification.count({ where: { type: 'whatsapp.pin_locked' } })).toBe(1);

      // Even the right PIN is refused while locked.
      const [tapped] = await tap(PHONES.approver, card.approve);
      expect(tapped && textOf(tapped)).toMatch(/locked until/);
      expect(
        (await t.prisma.changeRequest.findUniqueOrThrow({ where: { id: cr.id } })).status,
      ).toBe('AWAITING_APPROVAL');
    });

    it('rejects with a reason and asks clarification questions', async () => {
      await link('approver', { pin: true });
      await link('sales');
      const a = await requestIn('AWAITING_APPROVAL');
      const b = await requestIn('AWAITING_APPROVAL');

      const cardA = await cardFor('approver', a.key, 2);
      expect(textOf((await tap(PHONES.approver, cardA.reject))[0] as SentMessage)).toMatch(
        /reason for rejecting/,
      );
      expect(
        textOf((await say(PHONES.approver, 'Out of scope for this quarter'))[0] as SentMessage),
      ).toMatch(new RegExp(`${a.key} rejected`));
      expect(await t.prisma.changeRequest.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject(
        {
          status: 'REJECTED',
        },
      );

      const cardB = await cardFor('approver', b.key);
      await tap(PHONES.approver, cardB.clarify);
      await say(PHONES.approver, '1. Which columns?\n2. Should totals be included?');
      expect(await t.prisma.changeRequest.findUniqueOrThrow({ where: { id: b.id } })).toMatchObject(
        {
          status: 'CLARIFICATION_REQUIRED',
          pendingQuestions: ['Which columns?', 'Should totals be included?'],
        },
      );

      // The requester gets status and clarification messages on WhatsApp (window open).
      await dispatch();
      const toRequester = await graph.waitFor(PHONES.sales, 2);
      const texts = toRequester.map(textOf).join('\n---\n');
      expect(texts).toContain(`${a.key}: Rejected`);
      expect(texts).toContain('Which columns?');
    });

    it('refuses a card whose plan changed and sends a fresh one', async () => {
      await link('approver', { pin: true });
      const cr = await requestIn('AWAITING_APPROVAL');
      const card = await cardFor('approver', cr.key);
      const v2 = await t.prisma.implementationPlan.create({
        data: { changeRequestId: cr.id, version: 2, plan: { fixture: 2 }, agent: 'test' },
      });
      await t.prisma.changeRequest.update({ where: { id: cr.id }, data: { currentPlanId: v2.id } });

      const replies = await tap(PHONES.approver, card.approve, 'Approve', 2);
      expect(textOf(replies[0] as SentMessage)).toMatch(/plan .* changed/);
      expect(textOf(replies[1] as SentMessage)).toMatch(/plan v2/);
      expect(
        (await t.prisma.changeRequest.findUniqueOrThrow({ where: { id: cr.id } })).status,
      ).toBe('AWAITING_APPROVAL');
    });

    it('does not let anyone decide on their own request from WhatsApp', async () => {
      await link('admin', { pin: true });
      const own = await requestIn('AWAITING_APPROVAL', 'admin');
      const [reply] = await say(PHONES.admin, 'pending');
      expect(reply && textOf(reply)).toBe('Nothing is waiting for your approval.');
      expect(await t.prisma.pendingAction.count({ where: { changeRequestId: own.id } })).toBe(0);
    });

    it('asks for a PIN to be set before approving', async () => {
      await link('approver');
      const cr = await requestIn('AWAITING_APPROVAL');
      const card = await cardFor('approver', cr.key);
      const [reply] = await tap(PHONES.approver, card.approve);
      expect(reply && textOf(reply)).toBe(
        'Set your approval PIN first: https://evolvesales.test/profile',
      );
    });
  });

  describe('profile', () => {
    const auth = { type: 'bearer' } as const;

    it('sets the approval PIN only with the password, only for approvers, never a weak PIN', async () => {
      const put = async (who: keyof Fixtures['users'], pin: string, password = TEST_PASSWORD) =>
        t
          .http()
          .put(`${API}/profile/approval-pin`)
          .auth(await token(who), auth)
          .send({ pin, currentPassword: password });
      expect((await put('sales', GOOD_PIN)).status).toBe(403);
      expect((await put('approver', GOOD_PIN, 'wrong-password')).status).toBe(403);
      expect((await put('approver', '123456')).status).toBe(422);
      expect((await put('approver', '12345')).status).toBe(400);
      expect((await put('approver', GOOD_PIN)).status).toBe(204);
      const row = await t.prisma.user.findUniqueOrThrow({ where: { id: fx.users.approver.id } });
      expect(row.approvalPinHash).toMatch(/^\$argon2id\$/);
      const profile = (
        await t
          .http()
          .get(`${API}/profile/whatsapp`)
          .auth(await token('approver'), auth)
      ).body as WhatsAppProfileDto;
      expect(profile).toMatchObject({ hasApprovalPin: true, canApprove: true });
    });

    it('honours notification preferences', async () => {
      await link('sales');
      const prefs = { statusChanged: false, awaitingApproval: true, clarificationNeeded: true };
      const res = await t
        .http()
        .put(`${API}/profile/notification-prefs`)
        .auth(await token('sales'), auth)
        .send(prefs);
      expect(res.status).toBe(200);
      await requestIn('REJECTED');
      await dispatch();
      await new Promise((r) => setTimeout(r, 300));
      expect(graph.to(PHONES.sales)).toHaveLength(0);
    });
  });

  describe('delivery tracking', () => {
    it('records delivery statuses and never moves a status backwards', async () => {
      await say(PHONES.stranger, 'hi');
      const out = await t.prisma.outboundMessage.findFirstOrThrow();
      expect(out).toMatchObject({ status: 'SENT', kind: 'TEXT' });
      const status = (s: string) =>
        post(
          webhookBody({ statuses: [{ id: out.waMessageId, status: s, timestamp: '1763640000' }] }),
        );
      await status('read');
      await status('delivered');
      expect(
        await t.prisma.outboundMessage.findUniqueOrThrow({ where: { id: out.id } }),
      ).toMatchObject({
        status: 'READ',
      });
    });

    it('records failed sends without crashing the worker', async () => {
      graph.failWith = 400;
      await incoming(PHONES.stranger, { type: 'text', text: { body: 'hi' } });
      const started = Date.now();
      while (Date.now() - started < 10_000) {
        if ((await t.prisma.outboundMessage.count({ where: { status: 'FAILED' } })) > 0) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const failed = await t.prisma.outboundMessage.findFirstOrThrow({
        where: { status: 'FAILED' },
      });
      expect(failed.error).toContain('131047');
    });
  });
});

describe('WhatsApp disabled', () => {
  let t: TestApp;
  afterAll(async () => {
    await t.close();
  });

  it('hides the webhook (404) and reports the channel as off', async () => {
    t = await createTestApp();
    await resetDatabase(t.prisma);
    const fx = await seedFixtures(t.prisma);
    const res = await t
      .http()
      .post(`${API}/webhooks/whatsapp`)
      .set('content-type', 'application/json')
      .send('{}');
    expect(res.status).toBe(404);
    const profile = await t
      .http()
      .get(`${API}/profile/whatsapp`)
      .auth(await loginAs(t, fx.users.sales.email), { type: 'bearer' });
    expect(profile.body).toMatchObject({ enabled: false, botNumber: null });
  });
});
