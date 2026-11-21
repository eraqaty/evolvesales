import { z } from 'zod';

/**
 * The parts of Meta's WhatsApp Cloud API webhook we use. Unknown fields are ignored (Meta adds
 * fields over time); anything we cannot read is skipped instead of failing the whole delivery.
 */
const messageSchema = z.object({
  from: z.string().regex(/^\d{6,20}$/),
  id: z.string().min(1).max(200),
  timestamp: z.string().optional(),
  type: z.string(),
  text: z.object({ body: z.string() }).optional(),
  interactive: z
    .object({
      type: z.string(),
      button_reply: z.object({ id: z.string(), title: z.string() }).optional(),
      list_reply: z.object({ id: z.string(), title: z.string() }).optional(),
    })
    .optional(),
  /** Quick-reply button tapped on a template message. */
  button: z.object({ payload: z.string(), text: z.string() }).optional(),
});

const statusSchema = z.object({
  id: z.string().min(1),
  status: z.string(),
  timestamp: z.string().optional(),
  recipient_id: z.string().optional(),
  errors: z
    .array(z.object({ code: z.number().optional(), title: z.string().optional() }))
    .optional(),
});

const valueSchema = z.object({
  metadata: z.object({ phone_number_id: z.string() }).optional(),
  messages: z.array(z.unknown()).optional(),
  statuses: z.array(z.unknown()).optional(),
});

const webhookSchema = z.object({
  object: z.string(),
  entry: z
    .array(
      z.object({
        changes: z.array(z.object({ field: z.string(), value: z.unknown() })).default([]),
      }),
    )
    .default([]),
});

export type InboundMessage =
  | { kind: 'text'; id: string; from: string; text: string }
  /** A reply button, list row or template quick-reply: `replyId` is the payload we set. */
  | { kind: 'reply'; id: string; from: string; replyId: string; title: string }
  | { kind: 'unsupported'; id: string; from: string; type: string };

export interface StatusUpdate {
  waMessageId: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  at: Date;
  error: string | null;
}

export interface ParsedWebhook {
  messages: InboundMessage[];
  statuses: StatusUpdate[];
}

/** Extracts messages and delivery statuses addressed to our phone number id. */
export function parseWebhook(body: unknown, phoneNumberId: string): ParsedWebhook {
  const out: ParsedWebhook = { messages: [], statuses: [] };
  const parsed = webhookSchema.safeParse(body);
  if (!parsed.success || parsed.data.object !== 'whatsapp_business_account') return out;

  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      if (change.field !== 'messages') continue;
      const value = valueSchema.safeParse(change.value);
      if (!value.success) continue;
      if (value.data.metadata?.phone_number_id !== phoneNumberId) continue;

      for (const raw of value.data.messages ?? []) {
        const m = messageSchema.safeParse(raw);
        if (m.success) out.messages.push(toInbound(m.data));
      }
      for (const raw of value.data.statuses ?? []) {
        const s = statusSchema.safeParse(raw);
        if (!s.success) continue;
        const status = s.data.status;
        if (
          status !== 'sent' &&
          status !== 'delivered' &&
          status !== 'read' &&
          status !== 'failed'
        ) {
          continue;
        }
        const seconds = Number(s.data.timestamp);
        out.statuses.push({
          waMessageId: s.data.id,
          status,
          at: Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date(),
          error:
            s.data.errors
              ?.map((e) => [e.code, e.title].filter((x) => x !== undefined).join(' '))
              .join('; ')
              .slice(0, 300) || null,
        });
      }
    }
  }
  return out;
}

function toInbound(m: z.infer<typeof messageSchema>): InboundMessage {
  const base = { id: m.id, from: m.from };
  if (m.type === 'text' && m.text) return { ...base, kind: 'text', text: m.text.body };
  if (m.type === 'interactive' && m.interactive) {
    const reply = m.interactive.button_reply ?? m.interactive.list_reply;
    if (reply) return { ...base, kind: 'reply', replyId: reply.id, title: reply.title };
  }
  if (m.type === 'button' && m.button) {
    return { ...base, kind: 'reply', replyId: m.button.payload, title: m.button.text };
  }
  return { ...base, kind: 'unsupported', type: m.type.slice(0, 40) };
}

/** Meta sends numbers without "+"; we store E.164. */
export const toE164 = (waId: string): string => `+${waId}`;
