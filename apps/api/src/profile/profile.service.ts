import {
  ConflictException,
  ForbiddenException,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import argon2 from 'argon2';
import { createHash, randomInt } from 'node:crypto';
import {
  type LinkPhoneResult,
  type NotificationPrefs,
  parseNotificationPrefs,
  PHONE_LINK,
  Role,
  type WhatsAppProfileDto,
} from '@evolvesales/shared';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth.types.js';
import type { RequestContext } from '../common/request-context.js';
import { AppConfig } from '../config/app-config.js';
import { PrismaService } from '../prisma/prisma.service.js';

export type LinkOutcome =
  | { ok: true; userId: string; displayName: string }
  | { ok: false; reason: 'no_pending' | 'wrong_code' | 'taken' };

/** Approvers and admins can approve on WhatsApp and therefore need an approval PIN. */
export const canApprove = (roles: readonly string[]): boolean =>
  roles.includes(Role.ChangeApprover) || roles.includes(Role.Admin);

/** Shows only the last 4 digits in audit records (phone numbers are personal data). */
export const maskPhone = (e164: string): string => `…${e164.slice(-4)}`;

const hashCode = (phone: string, code: string): string =>
  createHash('sha256').update(`${phone}:${code}`).digest('hex');

/** PINs that are trivially guessed: one repeated digit or a straight run (123456, 654321). */
export function isWeakPin(pin: string): boolean {
  if (/^(\d)\1{5}$/.test(pin)) return true;
  const digits = Array.from(pin, Number);
  const steps = digits.slice(1).map((d, i) => d - (digits[i] ?? 0));
  return steps.every((s) => s === 1) || steps.every((s) => s === -1);
}

/**
 * The user's WhatsApp link, approval PIN and notification preferences (§19.3, §19.5).
 * Linking: the web page issues a code, and the user proves the number by sending it *from* that
 * number (Meta signs the webhook, so the sender is authentic).
 */
@Injectable()
export class ProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: AppConfig,
  ) {}

  async getWhatsApp(user: AuthUser): Promise<WhatsAppProfileDto> {
    const row = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: {
        phoneE164: true,
        phoneVerifiedAt: true,
        approvalPinHash: true,
        pinLockedUntil: true,
        notificationPrefs: true,
        roles: true,
      },
    });
    const pending = await this.prisma.phoneVerification.findFirst({
      where: { userId: user.id, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      select: { phoneE164: true, expiresAt: true },
    });
    const locked =
      row.pinLockedUntil && row.pinLockedUntil > new Date() ? row.pinLockedUntil : null;
    return {
      enabled: this.config.whatsapp !== null,
      botNumber: this.config.whatsapp?.displayNumber ?? null,
      phone: row.phoneVerifiedAt ? row.phoneE164 : null,
      verifiedAt: row.phoneVerifiedAt?.toISOString() ?? null,
      pending: pending
        ? { phone: pending.phoneE164, expiresAt: pending.expiresAt.toISOString() }
        : null,
      hasApprovalPin: row.approvalPinHash !== null,
      pinLockedUntil: locked?.toISOString() ?? null,
      canApprove: canApprove(row.roles),
      prefs: parseNotificationPrefs(row.notificationPrefs),
    };
  }

  /** Step 1 of linking: a fresh 6-digit code for `phone`, valid for 10 minutes. */
  async startLink(phone: string, user: AuthUser, ctx: RequestContext): Promise<LinkPhoneResult> {
    const owner = await this.prisma.user.findUnique({
      where: { phoneE164: phone },
      select: { id: true },
    });
    if (owner && owner.id !== user.id) {
      throw new ConflictException('This number is already linked to another account');
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = new Date(Date.now() + PHONE_LINK.codeTtlMinutes * 60_000);
    await this.prisma.$transaction(async (tx) => {
      // Only the newest code is valid.
      await tx.phoneVerification.updateMany({
        where: { userId: user.id, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      await tx.phoneVerification.create({
        data: { userId: user.id, phoneE164: phone, codeHash: hashCode(phone, code), expiresAt },
      });
      await this.audit.record(
        {
          action: 'profile.phone_link_started',
          entityType: 'User',
          entityId: user.id,
          after: { phone: maskPhone(phone) },
        },
        ctx,
        tx,
      );
    });

    const bot = this.config.whatsapp?.displayNumber ?? null;
    const digits = bot?.replace(/\D/g, '') ?? '';
    return {
      code,
      phone,
      expiresAt: expiresAt.toISOString(),
      botNumber: bot,
      waLink: digits ? `https://wa.me/${digits}?text=${encodeURIComponent(`LINK ${code}`)}` : null,
    };
  }

  /**
   * Step 2, called by the WhatsApp worker when "LINK <code>" arrives from `fromPhone`.
   * The sender must be the number the user entered, and the code must match (5 attempts).
   */
  async completeLink(fromPhone: string, code: string, ctx: RequestContext): Promise<LinkOutcome> {
    return this.prisma.$transaction(async (tx) => {
      const pending = await tx.phoneVerification.findFirst({
        where: {
          phoneE164: fromPhone,
          consumedAt: null,
          expiresAt: { gt: new Date() },
          attempts: { lt: PHONE_LINK.maxAttempts },
        },
        orderBy: { createdAt: 'desc' },
        include: { user: { select: { id: true, displayName: true, isActive: true } } },
      });
      if (!pending || !pending.user.isActive) return { ok: false, reason: 'no_pending' };

      if (pending.codeHash !== hashCode(fromPhone, code)) {
        await tx.phoneVerification.update({
          where: { id: pending.id },
          data: { attempts: { increment: 1 } },
        });
        return { ok: false, reason: 'wrong_code' };
      }

      const owner = await tx.user.findUnique({
        where: { phoneE164: fromPhone },
        select: { id: true },
      });
      // phoneE164 is only ever set together with phoneVerifiedAt, so any owner is a verified one.
      if (owner && owner.id !== pending.userId) return { ok: false, reason: 'taken' };

      await tx.phoneVerification.update({
        where: { id: pending.id },
        data: { consumedAt: new Date() },
      });
      await tx.user.update({
        where: { id: pending.userId },
        data: {
          phoneE164: fromPhone,
          phoneVerifiedAt: new Date(),
          whatsappLastInboundAt: new Date(),
        },
      });
      await this.audit.record(
        {
          action: 'profile.phone_linked',
          entityType: 'User',
          entityId: pending.userId,
          actorId: pending.userId,
          after: { phone: maskPhone(fromPhone), channel: 'WHATSAPP' },
        },
        ctx,
        tx,
      );
      return { ok: true, userId: pending.userId, displayName: pending.user.displayName };
    });
  }

  async unlink(user: AuthUser, ctx: RequestContext): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { phoneE164: null, phoneVerifiedAt: null },
      });
      await tx.phoneVerification.updateMany({
        where: { userId: user.id, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      // Approval cards already on that phone stop working.
      await tx.pendingAction.updateMany({
        where: { userId: user.id, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      await this.audit.record(
        { action: 'profile.phone_unlinked', entityType: 'User', entityId: user.id },
        ctx,
        tx,
      );
    });
  }

  async setApprovalPin(
    pin: string,
    currentPassword: string,
    user: AuthUser,
    ctx: RequestContext,
  ): Promise<void> {
    if (!canApprove(user.roles)) {
      throw new ForbiddenException('Only approvers and admins approve on WhatsApp');
    }
    if (isWeakPin(pin)) {
      throw new UnprocessableEntityException('Choose a PIN that is not a repeated digit or a run');
    }
    const row = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { passwordHash: true },
    });
    const ok = await argon2.verify(row.passwordHash, currentPassword).catch(() => false);
    if (!ok) {
      await this.audit.record(
        { action: 'profile.approval_pin_rejected', entityType: 'User', entityId: user.id },
        ctx,
      );
      throw new ForbiddenException('The current password is not correct');
    }
    const hash = await argon2.hash(pin, { type: argon2.argon2id });
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { approvalPinHash: hash, pinFailedCount: 0, pinLockedUntil: null },
      });
      await this.audit.record(
        { action: 'profile.approval_pin_set', entityType: 'User', entityId: user.id },
        ctx,
        tx,
      );
    });
  }

  async setNotificationPrefs(
    prefs: NotificationPrefs,
    user: AuthUser,
    ctx: RequestContext,
  ): Promise<NotificationPrefs> {
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { notificationPrefs: prefs } });
      await this.audit.record(
        {
          action: 'profile.notification_prefs_changed',
          entityType: 'User',
          entityId: user.id,
          after: prefs,
        },
        ctx,
        tx,
      );
    });
    return prefs;
  }
}
