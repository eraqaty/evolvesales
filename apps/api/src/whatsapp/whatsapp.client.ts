import { Injectable, Logger } from '@nestjs/common';
import type { OutboundKind } from '@evolvesales/db';
import { AppConfig } from '../config/app-config.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { GraphMessage } from './renderer.js';

export interface SendMeta {
  userId: string | null;
  /** Short, non-sensitive description stored with the delivery record. */
  summary: string;
  notificationId?: string;
}

export interface SendResult {
  ok: boolean;
  waMessageId: string | null;
  error: string | null;
}

/**
 * Sends messages through the Graph API (`POST /{phone-number-id}/messages`) and records each one
 * as an OutboundMessage, so delivery statuses from the webhook can be matched to it (§19.2).
 * The access token and message bodies are never logged.
 */
@Injectable()
export class WhatsAppClient {
  private readonly logger = new Logger(WhatsAppClient.name);

  constructor(
    private readonly config: AppConfig,
    private readonly prisma: PrismaService,
  ) {}

  async send(toE164: string, message: GraphMessage, meta: SendMeta): Promise<SendResult> {
    const wa = this.config.whatsapp;
    const record = await this.prisma.outboundMessage.create({
      data: {
        userId: meta.userId,
        toPhone: toE164,
        kind: kindOf(message),
        template: templateName(message),
        summary: meta.summary.slice(0, 200),
        notificationId: meta.notificationId ?? null,
      },
      select: { id: true },
    });
    if (!wa) {
      return this.fail(record.id, 'WhatsApp is not enabled');
    }

    try {
      const res = await fetch(`${wa.graphUrl}/${encodeURIComponent(wa.phoneNumberId)}/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${wa.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: toE164.replace(/^\+/, ''),
          ...message,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json().catch(() => null)) as GraphResponse | null;
      if (!res.ok) {
        const reason = body?.error
          ? `${body.error.code ?? res.status} ${body.error.message ?? ''}`.trim()
          : `HTTP ${res.status}`;
        return this.fail(record.id, reason);
      }
      const waMessageId = body?.messages?.[0]?.id ?? null;
      await this.prisma.outboundMessage.update({
        where: { id: record.id },
        data: { status: 'SENT', sentAt: new Date(), waMessageId },
      });
      return { ok: true, waMessageId, error: null };
    } catch (err) {
      return this.fail(record.id, err instanceof Error ? err.name : 'request failed');
    }
  }

  private async fail(id: string, reason: string): Promise<SendResult> {
    const error = reason.slice(0, 300);
    this.logger.warn(`WhatsApp send failed (outbound ${id}): ${error}`);
    await this.prisma.outboundMessage.update({
      where: { id },
      data: { status: 'FAILED', error },
    });
    return { ok: false, waMessageId: null, error };
  }
}

interface GraphResponse {
  messages?: Array<{ id?: string }>;
  error?: { code?: number; message?: string };
}

function kindOf(message: GraphMessage): OutboundKind {
  if (message.type === 'template') return 'TEMPLATE';
  if (message.type === 'interactive') return 'INTERACTIVE';
  return 'TEXT';
}

function templateName(message: GraphMessage): string | null {
  const template = message['template'];
  if (typeof template === 'object' && template !== null && 'name' in template) {
    return typeof template.name === 'string' ? template.name : null;
  }
  return null;
}
