import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface SentMessage {
  path: string;
  authorization: string | undefined;
  body: {
    to: string;
    type: string;
    text?: { body: string };
    interactive?: {
      type: string;
      body: { text: string };
      action: {
        buttons?: Array<{ reply: { id: string; title: string } }>;
        sections?: Array<{ rows: Array<{ id: string; title: string }> }>;
      };
    };
    template?: {
      name: string;
      components: Array<{
        type: string;
        parameters: Array<{ type: string; text?: string; payload?: string }>;
      }>;
    };
  };
  waMessageId: string;
}

/**
 * A local stand-in for Meta's Graph API `POST /{version}/{phone-number-id}/messages`. It records
 * what the API sent and answers like Meta does, so tests never call the real service.
 */
export class FakeGraphApi {
  readonly sent: SentMessage[] = [];
  /** When set, the next sends fail with this HTTP status. */
  failWith: number | null = null;
  private server: Server | null = null;
  private counter = 0;

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      req.on('end', () => {
        if (req.method !== 'POST' || !req.url?.endsWith('/messages')) {
          res.writeHead(404).end();
          return;
        }
        if (this.failWith) {
          res.writeHead(this.failWith, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 131047, message: 'Re-engagement message' } }));
          return;
        }
        const waMessageId = `wamid.out.${++this.counter}`;
        this.sent.push({
          path: req.url,
          authorization: req.headers.authorization,
          body: JSON.parse(raw) as SentMessage['body'],
          waMessageId,
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            messaging_product: 'whatsapp',
            contacts: [{ wa_id: 'x' }],
            messages: [{ id: waMessageId }],
          }),
        );
      });
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  /** Messages sent to `phone` (E.164) since index `from`. */
  to(phone: string, from = 0): SentMessage[] {
    return this.sent.slice(from).filter((m) => `+${m.body.to}` === phone);
  }

  /** Waits until at least `count` messages went to `phone` after index `from`. */
  async waitFor(phone: string, count = 1, from = 0, timeoutMs = 30_000): Promise<SentMessage[]> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const got = this.to(phone, from);
      if (got.length >= count) {
        // Let a reply that is still being sent in several parts finish.
        await new Promise((r) => setTimeout(r, 150));
        return this.to(phone, from);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(
      `timed out waiting for ${count} message(s) to ${phone}; got: ${JSON.stringify(this.to(phone, from).map((m) => m.body))}`,
    );
  }
}

export function textOf(m: SentMessage): string {
  return m.body.text?.body ?? m.body.interactive?.body.text ?? '';
}

export function buttonsOf(m: SentMessage): Array<{ id: string; title: string }> {
  return m.body.interactive?.action.buttons?.map((b) => b.reply) ?? [];
}
