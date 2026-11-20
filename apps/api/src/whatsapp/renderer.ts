/**
 * Turns channel-neutral replies into WhatsApp Cloud API message bodies (§19.2), enforcing
 * Meta's limits so a long or odd reply never makes the Graph API reject the message.
 */

export const WA_LIMITS = {
  textChars: 4096,
  interactiveBodyChars: 1024,
  buttonTitleChars: 20,
  maxButtons: 3,
  listRowTitleChars: 24,
  listRowDescriptionChars: 72,
  listButtonChars: 20,
  maxListRows: 10,
  replyIdChars: 256,
  templateParamChars: 1000,
} as const;

export type GraphMessage = Record<string, unknown> & { type: string };

export interface ReplyButton {
  id: string;
  title: string;
}

export interface ListRow {
  id: string;
  title: string;
  description?: string;
}

/** Cuts to `max` characters, ending with an ellipsis when something was removed. */
export function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

/** Markdown from the LLM → WhatsApp formatting (*bold*, no headings, plain bullets). */
export function toWhatsAppFormatting(markdown: string): string {
  return markdown
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '*$1*')
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Splits text into WhatsApp-sized messages, preferring paragraph, line, then word breaks. */
export function chunkText(text: string, max: number = WA_LIMITS.textChars): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (Array.from(rest).length > max) {
    const window = Array.from(rest).slice(0, max).join('');
    const cut = Math.max(
      window.lastIndexOf('\n\n'),
      window.lastIndexOf('\n'),
      window.lastIndexOf(' '),
    );
    const at = cut > max / 2 ? cut : window.length;
    chunks.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function textMessages(text: string): GraphMessage[] {
  return chunkText(toWhatsAppFormatting(text)).map((body) => ({
    type: 'text',
    text: { body, preview_url: false },
  }));
}

export function buttonsMessage(
  body: string,
  buttons: readonly ReplyButton[],
  footer?: string,
): GraphMessage {
  if (buttons.length < 1 || buttons.length > WA_LIMITS.maxButtons) {
    throw new Error(`WhatsApp allows 1-${WA_LIMITS.maxButtons} reply buttons`);
  }
  return {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: clip(body, WA_LIMITS.interactiveBodyChars) },
      ...(footer && { footer: { text: clip(footer, 60) } }),
      action: {
        buttons: buttons.map((b) => ({
          type: 'reply',
          reply: { id: assertId(b.id), title: clip(b.title, WA_LIMITS.buttonTitleChars) },
        })),
      },
    },
  };
}

export function listMessage(body: string, button: string, rows: readonly ListRow[]): GraphMessage {
  if (rows.length < 1 || rows.length > WA_LIMITS.maxListRows) {
    throw new Error(`WhatsApp lists hold 1-${WA_LIMITS.maxListRows} rows`);
  }
  return {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: clip(body, WA_LIMITS.interactiveBodyChars) },
      action: {
        button: clip(button, WA_LIMITS.listButtonChars),
        sections: [
          {
            title: clip(button, 24),
            rows: rows.map((r) => ({
              id: assertId(r.id),
              title: clip(r.title, WA_LIMITS.listRowTitleChars),
              ...(r.description && {
                description: clip(r.description, WA_LIMITS.listRowDescriptionChars),
              }),
            })),
          },
        ],
      },
    },
  };
}

/**
 * A pre-approved template (used outside Meta's 24-hour window). Body parameters may not contain
 * newlines, tabs or more than four spaces in a row; quick-reply payloads are set per message.
 */
export function templateMessage(
  name: string,
  language: string,
  bodyParams: readonly string[],
  quickReplyPayloads: readonly string[] = [],
): GraphMessage {
  const components: Array<Record<string, unknown>> = [];
  if (bodyParams.length > 0) {
    components.push({
      type: 'body',
      parameters: bodyParams.map((text) => ({ type: 'text', text: templateParam(text) })),
    });
  }
  quickReplyPayloads.forEach((payload, index) => {
    components.push({
      type: 'button',
      sub_type: 'quick_reply',
      index: String(index),
      parameters: [{ type: 'payload', payload: assertId(payload) }],
    });
  });
  return {
    type: 'template',
    template: { name, language: { code: language }, components },
  };
}

export function templateParam(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return clip(flat || '-', WA_LIMITS.templateParamChars);
}

function assertId(id: string): string {
  if (!id || id.length > WA_LIMITS.replyIdChars) {
    throw new Error('WhatsApp reply ids must be 1-256 characters');
  }
  return id;
}
