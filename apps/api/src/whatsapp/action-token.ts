import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Tamper-proof approval-card buttons (§19.3). A button id is
 * `pa1.<pendingActionId>.<action>.<signature>`, where the signature is an HMAC over the id,
 * action, change request, plan version and a per-card nonce. The database row (PendingAction)
 * makes it single-use and expiring; the signature makes it unforgeable.
 */

export const CARD_ACTIONS = ['approve', 'reject', 'clarify'] as const;
export type CardAction = (typeof CARD_ACTIONS)[number];

export interface ActionClaims {
  pendingActionId: string;
  action: CardAction;
  changeRequestId: string;
  planVersion: number;
  nonce: string;
}

const PREFIX = 'pa1';

export function signAction(claims: ActionClaims, secret: string): string {
  return `${PREFIX}.${claims.pendingActionId}.${claims.action}.${mac(claims, secret)}`;
}

/** Reads the public parts of a button id; the signature is checked later against the stored row. */
export function readActionToken(
  token: string,
): { pendingActionId: string; action: CardAction; signature: string } | null {
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;
  const [, pendingActionId, action, signature] = parts;
  if (!pendingActionId || !/^[0-9a-f-]{36}$/i.test(pendingActionId)) return null;
  if (!isCardAction(action) || !signature) return null;
  return { pendingActionId, action, signature };
}

export function verifyActionSignature(
  claims: ActionClaims,
  signature: string,
  secret: string,
): boolean {
  const expected = Buffer.from(mac(claims, secret));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export const isActionToken = (id: string): boolean => id.startsWith(`${PREFIX}.`);

function isCardAction(value: string | undefined): value is CardAction {
  return (CARD_ACTIONS as readonly string[]).includes(value ?? '');
}

function mac(c: ActionClaims, secret: string): string {
  return createHmac('sha256', secret)
    .update(`${c.pendingActionId}|${c.action}|${c.changeRequestId}|${c.planVersion}|${c.nonce}`)
    .digest('base64url');
}
