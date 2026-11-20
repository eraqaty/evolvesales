import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifies Meta's `X-Hub-Signature-256: sha256=<hex>` header: an HMAC-SHA256 of the exact raw
 * request body, keyed with the App Secret (§19.2 step 1). Constant-time comparison.
 */
export function verifyMetaSignature(
  rawBody: Buffer | undefined,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (!rawBody || !header || !appSecret) return false;
  const match = /^sha256=([a-f0-9]{64})$/i.exec(header.trim());
  if (!match?.[1]) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  const given = Buffer.from(match[1], 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Builds the header value Meta would send; used by tests and local tooling. */
export function metaSignature(rawBody: string | Buffer, appSecret: string): string {
  return `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
}
