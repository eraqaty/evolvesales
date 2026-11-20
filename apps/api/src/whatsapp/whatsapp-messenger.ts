import { HttpException, Injectable } from '@nestjs/common';
import type { Role } from '@evolvesales/shared';
import type { AuthUser } from '../auth/auth.types.js';
import { WhatsAppClient } from './whatsapp.client.js';
import type { GraphMessage } from './renderer.js';
import { textMessages } from './renderer.js';

/** Meta's customer-service window: free-form messages only within 24 h of the user's last message. */
const WINDOW_MS = 24 * 60 * 60 * 1000;
/** Keep a margin so a message never arrives just after the window closed. */
const WINDOW_MARGIN_MS = 10 * 60 * 1000;

export function isWindowOpen(lastInboundAt: Date | null, now = new Date()): boolean {
  return (
    lastInboundAt !== null && now.getTime() - lastInboundAt.getTime() < WINDOW_MS - WINDOW_MARGIN_MS
  );
}

export interface Recipient {
  userId: string | null;
  phone: string;
}

/** The WhatsApp user as the rest of the API knows them (same shape as a JWT principal). */
export interface LinkedUser extends AuthUser {
  phone: string;
  lastInboundAt: Date | null;
  approvalPinHash: string | null;
  pinFailedCount: number;
  pinLockedUntil: Date | null;
}

export function toLinkedUser(row: {
  id: string;
  email: string;
  displayName: string;
  roles: string[];
  phoneE164: string | null;
  whatsappLastInboundAt: Date | null;
  approvalPinHash: string | null;
  pinFailedCount: number;
  pinLockedUntil: Date | null;
}): LinkedUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    roles: row.roles as Role[],
    phone: row.phoneE164 ?? '',
    lastInboundAt: row.whatsappLastInboundAt,
    approvalPinHash: row.approvalPinHash,
    pinFailedCount: row.pinFailedCount,
    pinLockedUntil: row.pinLockedUntil,
  };
}

export const LINKED_USER_SELECT = {
  id: true,
  email: true,
  displayName: true,
  roles: true,
  phoneE164: true,
  whatsappLastInboundAt: true,
  approvalPinHash: true,
  pinFailedCount: true,
  pinLockedUntil: true,
} as const;

/** Sends one or more messages in order; stops at the first failure. */
@Injectable()
export class WhatsAppMessenger {
  constructor(private readonly client: WhatsAppClient) {}

  async send(
    to: Recipient,
    messages: readonly GraphMessage[],
    summary: string,
    notificationId?: string,
  ): Promise<boolean> {
    for (const message of messages) {
      const result = await this.client.send(to.phone, message, {
        userId: to.userId,
        summary,
        ...(notificationId && { notificationId }),
      });
      if (!result.ok) return false;
    }
    return true;
  }

  text(to: Recipient, text: string, summary: string): Promise<boolean> {
    return this.send(to, textMessages(text), summary);
  }
}

export const recipientOf = (user: LinkedUser): Recipient => ({
  userId: user.id,
  phone: user.phone,
});

/** A user-facing sentence for an API error raised while acting on WhatsApp. */
export function describeError(err: unknown): string {
  if (err instanceof HttpException) {
    const body = err.getResponse();
    const message =
      typeof body === 'object' && body !== null && 'message' in body ? body.message : err.message;
    return Array.isArray(message) ? message.join('; ') : String(message);
  }
  return 'Something went wrong on our side. Please try again later.';
}
