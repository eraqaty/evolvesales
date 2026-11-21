import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { Prisma } from '@evolvesales/db';
import {
  type ChangeRequestProposal,
  type Clarification,
  CR_STATUS_LABELS,
  type Screen,
  SCREENS,
} from '@evolvesales/shared';
import { AssistantService } from '../assistant/assistant.service.js';
import type { RequestContext } from '../common/request-context.js';
import { AppConfig } from '../config/app-config.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { canApprove, ProfileService } from '../profile/profile.service.js';
import { QueueService } from '../queue/queue.service.js';
import { isActionToken } from './action-token.js';
import { buttonsMessage, type GraphMessage, listMessage, textMessages } from './renderer.js';
import {
  type InboundMessage,
  type ParsedWebhook,
  type StatusUpdate,
  toE164,
} from './webhook-payload.js';
import { WhatsAppApprovalsService } from './whatsapp-approvals.service.js';
import {
  describeError,
  LINKED_USER_SELECT,
  type LinkedUser,
  type Recipient,
  recipientOf,
  toLinkedUser,
  WhatsAppMessenger,
} from './whatsapp-messenger.js';

export const UNKNOWN_NUMBER_REPLY =
  "This number isn't linked to an EvolveSales account. To link it, open your Profile in the EvolveSales web app.";

export const SCREEN_LABELS: Record<Screen, string> = {
  'sales.invoices.list': 'Invoice list',
  'sales.invoices.editor': 'Invoice editor',
  'sales.invoices.details': 'Invoice details',
  'change-requests': 'Change requests',
  other: 'Other / not sure',
};

const HELP = [
  '*EvolveSales assistant*',
  'Ask about invoices and customers, or describe a change you want in the app.',
  '',
  '*new* – start a new conversation',
  '*status* – your change requests',
  '*pending* – requests waiting for your approval (approvers)',
  '*help* – this message',
].join('\n');

const STATUS_RANK = { PENDING: 0, SENT: 1, DELIVERED: 2, READ: 3, FAILED: 4 } as const;
type OutStatus = keyof typeof STATUS_RANK;

/**
 * The API's WhatsApp channel worker (§19.2). The webhook only stores and enqueues; this service
 * resolves the sender by verified phone and routes the message: linking, commands, approval
 * steps, or the same assistant the web drawer uses.
 */
@Injectable()
export class WhatsAppInboundService implements OnApplicationBootstrap {
  private readonly logger = new Logger(WhatsAppInboundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly assistant: AssistantService,
    private readonly approvals: WhatsAppApprovalsService,
    private readonly profile: ProfileService,
    private readonly messenger: WhatsAppMessenger,
    private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.whatsapp) return;
    await this.queue.workWhatsAppInbound(
      (data) => this.process(data.eventId),
      this.config.env.WHATSAPP_WORKER_POLL_SECONDS,
    );
  }

  /** Webhook step 2-3: store each message once (unique wamid) and enqueue it in the same transaction. */
  async ingest(parsed: ParsedWebhook): Promise<{ queued: number; duplicates: number }> {
    let queued = 0;
    let duplicates = 0;
    for (const message of parsed.messages) {
      try {
        await this.prisma.$transaction(async (tx) => {
          const event = await tx.inboundChannelEvent.create({
            data: {
              waMessageId: message.id,
              fromPhone: toE164(message.from),
              type: message.kind,
              payload: message as unknown as Prisma.InputJsonValue,
            },
            select: { id: true },
          });
          await this.queue.enqueueWhatsAppInbound(tx, { eventId: event.id });
        });
        queued++;
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          duplicates++; // Meta retried a delivery we already have.
          continue;
        }
        throw err;
      }
    }
    for (const status of parsed.statuses) await this.applyStatus(status);
    return { queued, duplicates };
  }

  /** Delivery statuses only move forward (sent → delivered → read), except to failed. */
  private async applyStatus(s: StatusUpdate): Promise<void> {
    const to = s.status.toUpperCase() as OutStatus;
    const lower = (Object.keys(STATUS_RANK) as OutStatus[]).filter(
      (k) => k !== 'FAILED' && STATUS_RANK[k] < STATUS_RANK[to],
    );
    await this.prisma.outboundMessage.updateMany({
      where: { waMessageId: s.waMessageId, status: { in: lower } },
      data: {
        status: to,
        ...(to === 'SENT' && { sentAt: s.at }),
        ...(to === 'DELIVERED' && { deliveredAt: s.at }),
        ...(to === 'READ' && { readAt: s.at }),
        ...(to === 'FAILED' && { error: s.error ?? 'failed' }),
      },
    });
  }

  /** Processes one stored message exactly once. */
  async process(eventId: string): Promise<void> {
    const claimed = await this.prisma.inboundChannelEvent.updateMany({
      where: { id: eventId, processedAt: null },
      data: { processedAt: new Date() },
    });
    if (claimed.count === 0) return;
    const event = await this.prisma.inboundChannelEvent.findUniqueOrThrow({
      where: { id: eventId },
    });
    const message = event.payload as unknown as InboundMessage;
    try {
      await this.handle(event.id, message);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.error(`WhatsApp message ${event.id} failed: ${reason.slice(0, 300)}`);
      await this.prisma.inboundChannelEvent.update({
        where: { id: event.id },
        data: { error: reason.slice(0, 1000) },
      });
      await this.messenger
        .text(
          { userId: null, phone: event.fromPhone },
          'Something went wrong on our side. Please try again in a moment.',
          'error reply',
        )
        .catch(() => undefined);
    }
  }

  private async handle(eventId: string, message: InboundMessage): Promise<void> {
    const phone = toE164(message.from);
    const row = await this.prisma.user.findFirst({
      where: { phoneE164: phone, phoneVerifiedAt: { not: null }, isActive: true },
      select: LINKED_USER_SELECT,
    });
    const ctx: RequestContext = {
      actorId: row?.id ?? null,
      ip: null,
      userAgent: 'whatsapp',
      correlationId: eventId,
      channel: 'WHATSAPP',
    };

    if (!row) {
      await this.handleUnknown(phone, message, ctx);
      return;
    }
    const now = new Date();
    await this.prisma.user.update({ where: { id: row.id }, data: { whatsappLastInboundAt: now } });
    const user = toLinkedUser({ ...row, whatsappLastInboundAt: now });
    const to = recipientOf(user);

    if (message.kind === 'unsupported') {
      await this.messenger.text(to, 'Text only for now. Please type your message.', 'unsupported');
      return;
    }
    if (message.kind === 'reply') {
      await this.handleReply(user, message.replyId, message.id, ctx);
      return;
    }

    const text = message.text.trim();
    const command = text.toLowerCase();
    const staged = await this.approvals.findStaged(user.id);
    if (staged) {
      if (command === 'cancel') {
        await this.approvals.cancel(user, staged);
        return;
      }
      // Redact first: a PIN (or something that looks like one) never stays in the database.
      if (staged.stage === 'AWAITING_PIN' || /\d{4,}/.test(text)) {
        await this.redact(eventId, message);
      }
      await this.approvals.handleStagedInput(user, staged, text, ctx);
      return;
    }

    if (/^link\s+\d{6}$/i.test(text)) {
      await this.messenger.text(
        to,
        'This number is already linked to your account.',
        'already linked',
      );
    } else if (
      command === 'help' ||
      command === 'menu' ||
      command === 'hi' ||
      command === 'hello'
    ) {
      await this.messenger.text(to, HELP, 'help');
    } else if (command === 'new') {
      await this.assistant.activeWhatsAppConversation(user, true);
      await this.messenger.text(to, 'Started a new conversation. What can I help you with?', 'new');
    } else if (command === 'status') {
      await this.sendStatus(user, to);
    } else if (command === 'pending') {
      await this.sendPending(user, to);
    } else if (command === 'cancel') {
      await this.messenger.text(to, 'Nothing to cancel.', 'cancel');
    } else {
      await this.converse(user, text, message.id, ctx);
    }
  }

  private async handleUnknown(
    phone: string,
    message: InboundMessage,
    ctx: RequestContext,
  ): Promise<void> {
    const to: Recipient = { userId: null, phone };
    const link = message.kind === 'text' ? /^link\s+(\d{6})$/i.exec(message.text.trim()) : null;
    if (!link?.[1]) {
      // No LLM call for unknown numbers (cost and data protection).
      await this.messenger.text(to, UNKNOWN_NUMBER_REPLY, 'unknown number');
      return;
    }
    const outcome = await this.profile.completeLink(phone, link[1], ctx);
    const replies = {
      no_pending:
        'There is no link request for this number. Start one from your Profile in the web app (codes are valid for 10 minutes).',
      wrong_code: 'That code is not correct. Check the code on your Profile page and try again.',
      taken: 'This number is already linked to another account.',
    } as const;
    await this.messenger.text(
      { userId: outcome.ok ? outcome.userId : null, phone },
      outcome.ok
        ? `✅ Linked to ${outcome.displayName}'s EvolveSales account.\n\n${HELP}`
        : replies[outcome.reason],
      outcome.ok ? 'linked' : `link ${outcome.reason}`,
    );
  }

  private async handleReply(
    user: LinkedUser,
    replyId: string,
    externalId: string,
    ctx: RequestContext,
  ): Promise<void> {
    const to = recipientOf(user);
    if (isActionToken(replyId)) {
      await this.approvals.handleButton(user, replyId, ctx);
      return;
    }
    const [kind, value] = replyId.split(':', 2);
    if (kind === 'submit' && value) {
      try {
        const result = await this.assistant.submit(value, user, ctx);
        await this.messenger.text(
          to,
          `✅ Submitted as *${result.key}*. You'll get a message here when it moves on.\nTrack it: ${this.config.publicWebUrl}/requests/${result.changeRequestId}`,
          `submitted ${result.key}`,
        );
      } catch (err) {
        await this.messenger.text(to, `Could not submit: ${describeError(err)}`, 'submit failed');
      }
      return;
    }
    if (kind === 'screen' && isScreen(value)) {
      const conversationId = await this.assistant.activeWhatsAppConversation(user);
      await this.assistant.setScreen(conversationId, value, user);
      await this.converse(user, `The change is about: ${SCREEN_LABELS[value]}`, externalId, ctx);
      return;
    }
    await this.messenger.text(to, 'That button is no longer valid.', 'unknown button');
  }

  /** Runs the shared assistant and renders its channel-neutral events for WhatsApp. */
  private async converse(
    user: LinkedUser,
    text: string,
    externalId: string,
    ctx: RequestContext,
  ): Promise<void> {
    const to = recipientOf(user);
    const conversationId = await this.assistant.activeWhatsAppConversation(user);
    let stream: Awaited<ReturnType<AssistantService['prepareMessage']>>;
    try {
      stream = await this.assistant.prepareMessage(conversationId, text, user, ctx, { externalId });
    } catch (err) {
      await this.messenger.text(to, assistantErrorText(err), 'assistant refused');
      return;
    }

    let reply = '';
    let proposal: ChangeRequestProposal | null = null;
    let clarification: Clarification | null = null;
    let askScreen = false;
    let failed: string | null = null;
    for await (const event of stream(AbortSignal.timeout(120_000))) {
      if (event.type === 'text') reply += event.delta;
      else if (event.type === 'proposal') proposal = event.proposal;
      else if (event.type === 'clarification') clarification = event.clarification;
      else if (event.type === 'tool' && event.name === 'ask_screen') askScreen = true;
      else if (event.type === 'error') failed = event.message;
    }

    const messages: GraphMessage[] = [];
    if (reply.trim()) messages.push(...textMessages(reply));
    else if (failed) messages.push(...textMessages(failed));
    if (clarification && !proposal) {
      const missing = clarification.questions.filter((q) => !reply.includes(q));
      if (missing.length > 0) {
        messages.push(...textMessages(missing.map((q, i) => `${i + 1}. ${q}`).join('\n')));
      }
    }
    if (askScreen && !proposal) {
      messages.push(
        listMessage(
          'Which part of the app is this change about?',
          'Choose a screen',
          SCREENS.map((s) => ({ id: `screen:${s}`, title: SCREEN_LABELS[s] })),
        ),
      );
    }
    if (proposal) {
      messages.push(
        buttonsMessage(
          proposalSummary(proposal),
          [{ id: `submit:${conversationId}`, title: 'Submit request' }],
          'Or reply to change it',
        ),
      );
    }
    if (messages.length === 0) messages.push(...textMessages('(no reply)'));
    await this.messenger.send(
      to,
      messages,
      proposal ? 'assistant reply + summary card' : 'assistant reply',
    );
  }

  private async sendStatus(user: LinkedUser, to: Recipient): Promise<void> {
    const rows = await this.prisma.changeRequest.findMany({
      where: { requesterId: user.id },
      orderBy: { updatedAt: 'desc' },
      take: 5,
      select: { key: true, title: true, status: true },
    });
    await this.messenger.text(
      to,
      rows.length === 0
        ? 'You have no change requests yet. Describe a change and I will help you write it up.'
        : [
            '*Your latest change requests*',
            ...rows.map((r) => `${r.key} – ${CR_STATUS_LABELS[r.status]}\n${r.title}`),
          ].join('\n\n'),
      'status',
    );
  }

  private async sendPending(user: LinkedUser, to: Recipient): Promise<void> {
    if (!canApprove(user.roles)) {
      await this.messenger.text(
        to,
        'Only approvers and admins have pending approvals.',
        'pending denied',
      );
      return;
    }
    const rows = await this.prisma.changeRequest.findMany({
      where: { status: 'AWAITING_APPROVAL', requesterId: { not: user.id } },
      orderBy: { updatedAt: 'asc' },
      take: 5,
      select: { id: true },
    });
    if (rows.length === 0) {
      await this.messenger.text(to, 'Nothing is waiting for your approval.', 'pending none');
      return;
    }
    for (const r of rows) await this.approvals.sendCard(user, r.id);
  }

  /** PINs never stay in the database: the stored copy of that message is overwritten. */
  private async redact(eventId: string, message: InboundMessage): Promise<void> {
    await this.prisma.inboundChannelEvent.update({
      where: { id: eventId },
      data: { payload: { ...message, text: '[redacted]' } as unknown as Prisma.InputJsonValue },
    });
  }
}

function isScreen(value: string | undefined): value is Screen {
  return (SCREENS as readonly string[]).includes(value ?? '');
}

export function proposalSummary(p: ChangeRequestProposal): string {
  return [
    `*${p.title}*`,
    p.description,
    '',
    `Screen: ${SCREEN_LABELS[p.screen]} · Priority: ${p.priority}`,
    '*Acceptance criteria*',
    ...p.acceptanceCriteria.map((c) => `• ${c}`),
  ].join('\n');
}

function assistantErrorText(err: unknown): string {
  if (err instanceof HttpException) {
    if (err.getStatus() === HttpStatus.SERVICE_UNAVAILABLE) {
      return "The AI assistant isn't configured on the server yet, so I can't answer. Please tell your administrator.";
    }
    if (err.getStatus() === HttpStatus.UNPROCESSABLE_ENTITY) {
      return `${describeError(err)}. Send *new* to start a new conversation.`;
    }
  }
  return describeError(err);
}
