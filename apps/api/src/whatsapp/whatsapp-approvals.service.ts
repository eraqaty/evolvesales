import { Injectable, Logger } from '@nestjs/common';
import argon2 from 'argon2';
import { createHmac, randomBytes } from 'node:crypto';
import type { PendingAction } from '@evolvesales/db';
import { APPROVAL_PIN, clarifyRequestSchema, CR_STATUS_LABELS } from '@evolvesales/shared';
import { AuditService } from '../audit/audit.service.js';
import { ChangeRequestsService } from '../change-requests/change-requests.service.js';
import type { RequestContext } from '../common/request-context.js';
import { AppConfig } from '../config/app-config.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { canApprove } from '../profile/profile.service.js';
import {
  type CardAction,
  CARD_ACTIONS,
  readActionToken,
  signAction,
  verifyActionSignature,
} from './action-token.js';
import { buttonsMessage, templateMessage } from './renderer.js';
import {
  describeError,
  isWindowOpen,
  type LinkedUser,
  recipientOf,
  WhatsAppMessenger,
} from './whatsapp-messenger.js';

const BUTTON_TITLES: Record<CardAction, string> = {
  approve: 'Approve',
  reject: 'Reject',
  clarify: 'Clarify',
};

export const APPROVAL_TEMPLATE = 'cr_awaiting_approval';

type StagedAction = PendingAction;

/**
 * Approval cards on WhatsApp (§19.3): Approve / Reject / Clarify buttons with signed, single-use,
 * expiring payloads; Approve needs the approval PIN. Every decision goes through the same
 * ChangeRequestsService as the web dashboard (role check, separation of duties, audit), with
 * channel = WHATSAPP.
 */
@Injectable()
export class WhatsAppApprovalsService {
  private readonly logger = new Logger(WhatsAppApprovalsService.name);
  private readonly secret: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly changeRequests: ChangeRequestsService,
    private readonly messenger: WhatsAppMessenger,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
  ) {
    this.secret =
      config.env.WHATSAPP_ACTION_SECRET ??
      createHmac('sha256', config.env.JWT_ACCESS_SECRET).update('whatsapp-actions').digest('hex');
  }

  /** Sends an approval card for a request waiting for approval. Returns false if not sent. */
  async sendCard(user: LinkedUser, changeRequestId: string, notificationId?: string) {
    const cr = await this.prisma.changeRequest.findUnique({
      where: { id: changeRequestId },
      select: {
        id: true,
        key: true,
        title: true,
        status: true,
        priority: true,
        requesterId: true,
        requester: { select: { displayName: true } },
        currentPlan: { select: { version: true } },
      },
    });
    if (!cr || cr.status !== 'AWAITING_APPROVAL' || !canApprove(user.roles)) return false;
    if (cr.requesterId === user.id) return false;

    const planVersion = cr.currentPlan?.version ?? 0;
    const pa = await this.prisma.pendingAction.create({
      data: {
        nonce: randomBytes(16).toString('hex'),
        userId: user.id,
        changeRequestId: cr.id,
        planVersion,
        expiresAt: new Date(Date.now() + APPROVAL_PIN.cardTtlHours * 3_600_000),
      },
    });
    const tokens = CARD_ACTIONS.map((action) =>
      signAction(
        { pendingActionId: pa.id, action, changeRequestId: cr.id, planVersion, nonce: pa.nonce },
        this.secret,
      ),
    );

    const link = `${this.config.publicWebUrl}/requests/${cr.id}`;
    const plan = planVersion > 0 ? `plan v${planVersion}` : 'no plan yet';
    const message = isWindowOpen(user.lastInboundAt)
      ? buttonsMessage(
          [
            `*${cr.key} needs your approval*`,
            cr.title,
            `Requested by ${cr.requester.displayName} · ${cr.priority} priority · ${plan}`,
            '',
            `Full request and plan: ${link}`,
            'Approve asks for your approval PIN.',
          ].join('\n'),
          CARD_ACTIONS.map((action, i) => ({ id: tokens[i] ?? '', title: BUTTON_TITLES[action] })),
          'Approval authorizes coding only',
        )
      : templateMessage(
          APPROVAL_TEMPLATE,
          this.config.whatsapp?.templateLanguage ?? 'en_US',
          [`${cr.key}: ${cr.title}`, cr.requester.displayName],
          tokens,
        );
    return this.messenger.send(
      recipientOf(user),
      [message],
      `approval card ${cr.key}`,
      notificationId,
    );
  }

  /** A tapped card button. */
  async handleButton(user: LinkedUser, token: string, ctx: RequestContext): Promise<void> {
    const to = recipientOf(user);
    const parsed = readActionToken(token);
    const pa = parsed
      ? await this.prisma.pendingAction.findUnique({ where: { id: parsed.pendingActionId } })
      : null;
    const valid =
      parsed &&
      pa &&
      pa.userId === user.id &&
      verifyActionSignature(
        {
          pendingActionId: pa.id,
          action: parsed.action,
          changeRequestId: pa.changeRequestId,
          planVersion: pa.planVersion,
          nonce: pa.nonce,
        },
        parsed.signature,
        this.secret,
      );
    if (!parsed || !pa || !valid) {
      await this.audit.record(
        {
          action: 'whatsapp.action_refused',
          entityType: 'PendingAction',
          after: { reason: 'invalid' },
        },
        ctx,
      );
      await this.messenger.text(to, 'This button is not valid.', 'invalid button');
      return;
    }
    if (pa.consumedAt) {
      await this.messenger.text(to, 'This card was already used.', 'used card');
      return;
    }
    if (pa.expiresAt <= new Date()) {
      await this.messenger.text(
        to,
        'This card has expired. Send *pending* to get fresh cards.',
        'expired card',
      );
      return;
    }

    const cr = await this.prisma.changeRequest.findUniqueOrThrow({
      where: { id: pa.changeRequestId },
      select: {
        id: true,
        key: true,
        status: true,
        requesterId: true,
        currentPlan: { select: { version: true } },
      },
    });
    if (cr.status !== 'AWAITING_APPROVAL') {
      await this.consume(pa.id);
      await this.messenger.text(
        to,
        `${cr.key} is no longer waiting for approval (now: ${CR_STATUS_LABELS[cr.status]}).`,
        `stale card ${cr.key}`,
      );
      return;
    }
    if ((cr.currentPlan?.version ?? 0) !== pa.planVersion) {
      await this.consume(pa.id);
      await this.audit.record(
        {
          action: 'whatsapp.action_refused',
          entityType: 'ChangeRequest',
          entityId: cr.id,
          after: { reason: 'plan_changed', cardPlanVersion: pa.planVersion },
        },
        ctx,
      );
      await this.messenger.text(
        to,
        `The plan for ${cr.key} changed after this card was sent. Here is a fresh card.`,
        `plan changed ${cr.key}`,
      );
      await this.sendCard(user, cr.id);
      return;
    }
    if (!canApprove(user.roles)) {
      await this.messenger.text(to, 'You are not allowed to decide on change requests.', 'no role');
      return;
    }
    if (cr.requesterId === user.id) {
      await this.messenger.text(
        to,
        'You cannot decide on your own request on WhatsApp. An admin can approve their own request in the web dashboard, with a reason.',
        `own request ${cr.key}`,
      );
      return;
    }

    const action = parsed.action;
    if (action === 'approve') {
      if (user.pinLockedUntil && user.pinLockedUntil > new Date()) {
        await this.messenger.text(to, lockedText(user.pinLockedUntil), 'pin locked');
        return;
      }
      if (!user.approvalPinHash) {
        await this.messenger.text(
          to,
          `Set your approval PIN first: ${this.config.publicWebUrl}/profile`,
          'no pin',
        );
        return;
      }
    }

    await this.stage(user.id, pa.id, action);
    const plan = pa.planVersion > 0 ? ` (plan v${pa.planVersion})` : '';
    const prompts: Record<CardAction, string> = {
      approve: `Enter your approval PIN for ${cr.key}${plan} within ${APPROVAL_PIN.stageMinutes} minutes.`,
      reject: `Reply with the reason for rejecting ${cr.key}. The requester will see it.`,
      clarify: `Reply with your questions for the requester of ${cr.key}, one per line.`,
    };
    await this.messenger.text(
      to,
      `${prompts[action]}\nSend *cancel* to stop.`,
      `${action} prompt ${cr.key}`,
    );
  }

  /**
   * The card waiting for this user's next message (PIN, reason or questions), if any. A step that
   * expired less than 30 minutes ago still catches the message, so a late PIN never reaches the
   * assistant (and the LLM).
   */
  findStaged(userId: string): Promise<StagedAction | null> {
    return this.prisma.pendingAction.findFirst({
      where: {
        userId,
        consumedAt: null,
        stage: { not: 'CARD' },
        stageExpiresAt: { gt: new Date(Date.now() - 30 * 60_000) },
      },
      orderBy: { stageExpiresAt: 'desc' },
    });
  }

  async cancel(user: LinkedUser, pa: StagedAction): Promise<void> {
    await this.prisma.pendingAction.update({
      where: { id: pa.id },
      data: { stage: 'CARD', action: null, stageExpiresAt: null },
    });
    await this.messenger.text(
      recipientOf(user),
      'Cancelled. The card stays valid; tap a button again when you are ready.',
      'cancelled',
    );
  }

  /**
   * The user's message after tapping a button. The caller has already redacted anything that
   * may be a PIN from storage.
   */
  async handleStagedInput(
    user: LinkedUser,
    pa: StagedAction,
    text: string,
    ctx: RequestContext,
  ): Promise<void> {
    const to = recipientOf(user);
    if (!pa.stageExpiresAt || pa.stageExpiresAt <= new Date()) {
      await this.prisma.pendingAction.update({
        where: { id: pa.id },
        data: { stage: 'CARD', action: null, stageExpiresAt: null },
      });
      await this.messenger.text(
        to,
        `That took longer than ${APPROVAL_PIN.stageMinutes} minutes. Tap the button on the card again.`,
        'stage expired',
      );
      return;
    }
    const cr = await this.prisma.changeRequest.findUniqueOrThrow({
      where: { id: pa.changeRequestId },
      select: { id: true, key: true },
    });

    if (pa.stage === 'AWAITING_PIN') {
      await this.checkPinAndApprove(user, pa, cr, text.trim(), ctx);
      return;
    }

    if (pa.stage === 'AWAITING_REASON') {
      const comment = text.trim().slice(0, 2000);
      if (comment.length < 3) {
        await this.messenger.text(
          to,
          'Please send a reason (a few words at least).',
          'reason short',
        );
        return;
      }
      if (!(await this.consume(pa.id))) return;
      try {
        await this.changeRequests.reject(cr.id, { comment }, user, ctx);
        await this.messenger.text(
          to,
          `${cr.key} rejected. The requester has been told.`,
          `rejected ${cr.key}`,
        );
      } catch (err) {
        await this.messenger.text(
          to,
          `Could not reject ${cr.key}: ${describeError(err)}`,
          'reject failed',
        );
      }
      return;
    }

    // AWAITING_QUESTIONS
    const questions = text
      .split('\n')
      .map((q) => q.replace(/^\s*(\d+[.)]|[-*•])\s*/, '').trim())
      .filter((q) => q.length > 0);
    const parsed = clarifyRequestSchema.safeParse({ questions });
    if (!parsed.success) {
      await this.messenger.text(to, 'Send 1 to 10 questions, one per line.', 'questions invalid');
      return;
    }
    if (!(await this.consume(pa.id))) return;
    try {
      await this.changeRequests.clarify(cr.id, parsed.data, user, ctx);
      await this.messenger.text(
        to,
        `Questions sent to the requester of ${cr.key}. You will get a new card when it is resubmitted.`,
        `clarify ${cr.key}`,
      );
    } catch (err) {
      await this.messenger.text(
        to,
        `Could not send the questions: ${describeError(err)}`,
        'clarify failed',
      );
    }
    return;
  }

  private async checkPinAndApprove(
    user: LinkedUser,
    pa: StagedAction,
    cr: { id: string; key: string },
    pin: string,
    ctx: RequestContext,
  ): Promise<void> {
    const to = recipientOf(user);
    if (!/^\d{6}$/.test(pin)) {
      await this.messenger.text(to, 'Send your 6-digit PIN, or *cancel*.', 'pin format');
      return;
    }
    // Re-read: the lock and counter may have changed since the message was queued.
    const row = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { approvalPinHash: true, pinFailedCount: true, pinLockedUntil: true },
    });
    if (row.pinLockedUntil && row.pinLockedUntil > new Date()) {
      await this.messenger.text(to, lockedText(row.pinLockedUntil), 'pin locked');
      return;
    }
    const ok =
      row.approvalPinHash !== null &&
      (await argon2.verify(row.approvalPinHash, pin).catch(() => false));

    if (!ok) {
      const failures = row.pinFailedCount + 1;
      if (failures >= APPROVAL_PIN.maxFailures) {
        const until = new Date(Date.now() + APPROVAL_PIN.lockMinutes * 60_000);
        await this.prisma.$transaction(async (tx) => {
          await tx.user.update({
            where: { id: user.id },
            data: { pinFailedCount: 0, pinLockedUntil: until },
          });
          await tx.pendingAction.update({
            where: { id: pa.id },
            data: { stage: 'CARD', action: null, stageExpiresAt: null },
          });
          await tx.notification.create({
            data: {
              userId: user.id,
              type: 'whatsapp.pin_locked',
              title: 'WhatsApp approvals locked',
              body: `${APPROVAL_PIN.maxFailures} wrong approval PINs. WhatsApp approvals are locked for ${APPROVAL_PIN.lockMinutes} minutes. If this was not you, change your password and PIN.`,
              link: '/profile',
            },
          });
          await this.audit.record(
            {
              action: 'whatsapp.approval_pin_locked',
              entityType: 'User',
              entityId: user.id,
              after: { changeRequestId: cr.id, lockedUntil: until.toISOString() },
            },
            ctx,
            tx,
          );
        });
        await this.messenger.text(to, lockedText(until), 'pin locked');
        return;
      }
      await this.prisma.user.update({
        where: { id: user.id },
        data: { pinFailedCount: failures },
      });
      await this.audit.record(
        {
          action: 'whatsapp.approval_pin_failed',
          entityType: 'User',
          entityId: user.id,
          after: { changeRequestId: cr.id, failures },
        },
        ctx,
      );
      const left = APPROVAL_PIN.maxFailures - failures;
      await this.messenger.text(
        to,
        `Wrong PIN. ${left} attempt${left === 1 ? '' : 's'} left before WhatsApp approvals are locked.`,
        'pin wrong',
      );
      return;
    }

    await this.prisma.user.update({ where: { id: user.id }, data: { pinFailedCount: 0 } });
    if (!(await this.consume(pa.id))) {
      await this.messenger.text(to, 'This card was already used.', 'used card');
      return;
    }
    try {
      await this.changeRequests.approve(cr.id, {}, user, ctx);
      const plan = pa.planVersion > 0 ? ` (plan v${pa.planVersion})` : '';
      await this.messenger.text(
        to,
        `✅ ${cr.key} approved${plan}. This authorizes the coding step only; nothing is deployed.`,
        `approved ${cr.key}`,
      );
    } catch (err) {
      this.logger.warn(`WhatsApp approval of ${cr.key} failed: ${describeError(err)}`);
      await this.messenger.text(
        to,
        `Could not approve ${cr.key}: ${describeError(err)}`,
        'approve failed',
      );
    }
  }

  private async stage(userId: string, id: string, action: CardAction): Promise<void> {
    const stage =
      action === 'approve'
        ? 'AWAITING_PIN'
        : action === 'reject'
          ? 'AWAITING_REASON'
          : 'AWAITING_QUESTIONS';
    await this.prisma.$transaction([
      // Only one card at a time waits for input.
      this.prisma.pendingAction.updateMany({
        where: { userId, consumedAt: null, stage: { not: 'CARD' }, id: { not: id } },
        data: { stage: 'CARD', action: null, stageExpiresAt: null },
      }),
      this.prisma.pendingAction.update({
        where: { id },
        data: {
          stage,
          action,
          stageExpiresAt: new Date(Date.now() + APPROVAL_PIN.stageMinutes * 60_000),
        },
      }),
    ]);
  }

  /** Marks a card used; false if another message used it first. */
  private async consume(id: string): Promise<boolean> {
    const { count } = await this.prisma.pendingAction.updateMany({
      where: { id, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    return count === 1;
  }
}

function lockedText(until: Date): string {
  return `WhatsApp approvals are locked until ${until.toISOString().slice(11, 16)} UTC after too many wrong PINs. You can still decide in the web dashboard.`;
}
