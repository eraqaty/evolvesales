import { describe, expect, it } from 'vitest';
import { isWeakPin } from '../profile/profile.service.js';
import { readActionToken, signAction, verifyActionSignature } from './action-token.js';
import {
  buttonsMessage,
  chunkText,
  listMessage,
  templateMessage,
  textMessages,
  toWhatsAppFormatting,
  WA_LIMITS,
} from './renderer.js';
import { metaSignature, verifyMetaSignature } from './signature.js';
import { parseWebhook } from './webhook-payload.js';
import { isWindowOpen } from './whatsapp-messenger.js';

const SECRET = 'app-secret';

describe('verifyMetaSignature', () => {
  const body = Buffer.from('{"object":"whatsapp_business_account"}');

  it('accepts the HMAC of the exact raw body', () => {
    expect(verifyMetaSignature(body, metaSignature(body, SECRET), SECRET)).toBe(true);
  });

  it('rejects a wrong secret, a changed body, a missing or malformed header', () => {
    expect(verifyMetaSignature(body, metaSignature(body, 'other'), SECRET)).toBe(false);
    expect(
      verifyMetaSignature(Buffer.from(`${body.toString()} `), metaSignature(body, SECRET), SECRET),
    ).toBe(false);
    expect(verifyMetaSignature(body, undefined, SECRET)).toBe(false);
    expect(verifyMetaSignature(body, 'sha1=abc', SECRET)).toBe(false);
    expect(verifyMetaSignature(undefined, metaSignature(body, SECRET), SECRET)).toBe(false);
    expect(verifyMetaSignature(body, metaSignature(body, SECRET), '')).toBe(false);
  });
});

describe('parseWebhook', () => {
  const wrap = (value: unknown, field = 'messages') => ({
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba', changes: [{ field, value }] }],
  });
  const meta = { phone_number_id: 'PNID' };

  it('reads text, button replies, list replies, template quick replies and unsupported types', () => {
    const parsed = parseWebhook(
      wrap({
        metadata: meta,
        messages: [
          { from: '201000000001', id: 'w1', type: 'text', text: { body: 'hi' } },
          {
            from: '201000000001',
            id: 'w2',
            type: 'interactive',
            interactive: { type: 'button_reply', button_reply: { id: 'b1', title: 'Approve' } },
          },
          {
            from: '201000000001',
            id: 'w3',
            type: 'interactive',
            interactive: { type: 'list_reply', list_reply: { id: 'l1', title: 'Invoice list' } },
          },
          {
            from: '201000000001',
            id: 'w4',
            type: 'button',
            button: { payload: 'p1', text: 'Reject' },
          },
          { from: '201000000001', id: 'w5', type: 'image', image: { id: 'm' } },
        ],
      }),
      'PNID',
    );
    expect(parsed.messages).toEqual([
      { kind: 'text', id: 'w1', from: '201000000001', text: 'hi' },
      { kind: 'reply', id: 'w2', from: '201000000001', replyId: 'b1', title: 'Approve' },
      { kind: 'reply', id: 'w3', from: '201000000001', replyId: 'l1', title: 'Invoice list' },
      { kind: 'reply', id: 'w4', from: '201000000001', replyId: 'p1', title: 'Reject' },
      { kind: 'unsupported', id: 'w5', from: '201000000001', type: 'image' },
    ]);
  });

  it('reads delivery statuses with errors', () => {
    const parsed = parseWebhook(
      wrap({
        metadata: meta,
        statuses: [
          { id: 'o1', status: 'delivered', timestamp: '1700000000' },
          {
            id: 'o2',
            status: 'failed',
            timestamp: '1700000000',
            errors: [{ code: 131047, title: 'Re-engagement message' }],
          },
          { id: 'o3', status: 'deleted' },
        ],
      }),
      'PNID',
    );
    expect(parsed.statuses).toEqual([
      { waMessageId: 'o1', status: 'delivered', at: new Date(1_700_000_000_000), error: null },
      {
        waMessageId: 'o2',
        status: 'failed',
        at: new Date(1_700_000_000_000),
        error: '131047 Re-engagement message',
      },
    ]);
  });

  it('ignores other phone numbers, other objects, other fields and malformed messages', () => {
    const msg = { from: '201000000001', id: 'w1', type: 'text', text: { body: 'hi' } };
    expect(
      parseWebhook(wrap({ metadata: { phone_number_id: 'OTHER' }, messages: [msg] }), 'PNID')
        .messages,
    ).toEqual([]);
    expect(
      parseWebhook({ ...wrap({ metadata: meta, messages: [msg] }), object: 'page' }, 'PNID')
        .messages,
    ).toEqual([]);
    expect(
      parseWebhook(wrap({ metadata: meta, messages: [msg] }, 'account_update'), 'PNID').messages,
    ).toEqual([]);
    expect(
      parseWebhook(wrap({ metadata: meta, messages: [{ ...msg, from: '+20 100' }] }), 'PNID')
        .messages,
    ).toEqual([]);
    expect(parseWebhook('garbage', 'PNID')).toEqual({ messages: [], statuses: [] });
  });
});

describe('renderer', () => {
  it("chunks long text at WhatsApp's 4,096-character limit, preferring line breaks", () => {
    const para = 'x'.repeat(3000);
    const chunks = chunkText(`${para}\n\n${para}`);
    expect(chunks).toEqual([para, para]);
    const unbroken = chunkText('y'.repeat(9000));
    expect(unbroken.map((c) => c.length)).toEqual([4096, 4096, 808]);
    expect(textMessages('a').length).toBe(1);
  });

  it('converts Markdown to WhatsApp formatting', () => {
    expect(toWhatsAppFormatting('## Total\n**EGP 1,000**\n- one\n- two')).toBe(
      '*Total*\n*EGP 1,000*\n• one\n• two',
    );
  });

  it('allows 1-3 reply buttons and clips titles to 20 characters', () => {
    const msg = buttonsMessage('body', [{ id: 'a', title: 'A very long button title indeed' }]);
    const buttons = (
      msg['interactive'] as { action: { buttons: Array<{ reply: { title: string } }> } }
    ).action.buttons;
    expect(Array.from(buttons[0]?.reply.title ?? '').length).toBe(WA_LIMITS.buttonTitleChars);
    const four = [1, 2, 3, 4].map((i) => ({ id: `b${i}`, title: `B${i}` }));
    expect(() => buttonsMessage('body', four)).toThrow('1-3 reply buttons');
    expect(() => buttonsMessage('body', [])).toThrow('1-3 reply buttons');
    expect(() => buttonsMessage('body', [{ id: 'z'.repeat(257), title: 'x' }])).toThrow(
      '1-256 characters',
    );
  });

  it('allows at most 10 list rows', () => {
    const rows = Array.from({ length: 11 }, (_, i) => ({ id: `r${i}`, title: `Row ${i}` }));
    expect(() => listMessage('body', 'Choose', rows)).toThrow('1-10 rows');
    expect(() => listMessage('body', 'Choose', rows.slice(0, 10))).not.toThrow();
  });

  it('flattens template parameters and sets quick-reply payloads per button', () => {
    const msg = templateMessage(
      'cr_awaiting_approval',
      'en_US',
      ['line1\nline2\t     x'],
      ['p0', 'p1'],
    );
    expect(msg).toEqual({
      type: 'template',
      template: {
        name: 'cr_awaiting_approval',
        language: { code: 'en_US' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: 'line1 line2 x' }] },
          {
            type: 'button',
            sub_type: 'quick_reply',
            index: '0',
            parameters: [{ type: 'payload', payload: 'p0' }],
          },
          {
            type: 'button',
            sub_type: 'quick_reply',
            index: '1',
            parameters: [{ type: 'payload', payload: 'p1' }],
          },
        ],
      },
    });
  });
});

describe('action tokens', () => {
  const claims = {
    pendingActionId: '01936b2e-0000-7000-8000-000000000001',
    action: 'approve' as const,
    changeRequestId: '01936b2e-0000-7000-8000-000000000002',
    planVersion: 2,
    nonce: 'n1',
  };

  it('round-trips and fits in a WhatsApp reply id', () => {
    const token = signAction(claims, SECRET);
    expect(token.length).toBeLessThanOrEqual(WA_LIMITS.replyIdChars);
    const read = readActionToken(token);
    expect(read).toMatchObject({ pendingActionId: claims.pendingActionId, action: 'approve' });
    expect(verifyActionSignature(claims, read?.signature ?? '', SECRET)).toBe(true);
  });

  it('fails when the action, plan version, nonce or secret differ', () => {
    const sig = readActionToken(signAction(claims, SECRET))?.signature ?? '';
    expect(verifyActionSignature({ ...claims, action: 'reject' }, sig, SECRET)).toBe(false);
    expect(verifyActionSignature({ ...claims, planVersion: 3 }, sig, SECRET)).toBe(false);
    expect(verifyActionSignature({ ...claims, nonce: 'n2' }, sig, SECRET)).toBe(false);
    expect(verifyActionSignature(claims, sig, 'other')).toBe(false);
  });

  it('rejects malformed ids', () => {
    expect(readActionToken('submit:abc')).toBeNull();
    expect(readActionToken(`pa1.${claims.pendingActionId}.deploy.sig`)).toBeNull();
    expect(readActionToken('pa1.not-a-uuid.approve.sig')).toBeNull();
  });
});

describe('isWeakPin', () => {
  it('refuses repeated digits and straight runs', () => {
    for (const pin of ['000000', '111111', '123456', '654321', '345678']) {
      expect({ pin, weak: isWeakPin(pin) }).toEqual({ pin, weak: true });
    }
    for (const pin of ['482915', '120456', '102938']) {
      expect({ pin, weak: isWeakPin(pin) }).toEqual({ pin, weak: false });
    }
  });
});

describe('isWindowOpen', () => {
  const now = new Date('2026-11-20T12:00:00Z');
  it('is open within 24 h (minus a safety margin) of the last inbound message', () => {
    expect(isWindowOpen(null, now)).toBe(false);
    expect(isWindowOpen(new Date('2026-11-20T00:00:00Z'), now)).toBe(true);
    expect(isWindowOpen(new Date('2026-11-19T12:05:00Z'), now)).toBe(false);
    expect(isWindowOpen(new Date('2026-11-19T11:00:00Z'), now)).toBe(false);
  });
});
