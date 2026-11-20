import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestApp,
  type Fixtures,
  resetDatabase,
  seedFixtures,
  TEST_PASSWORD,
  type TestApp,
} from './helpers.js';

function refreshCookie(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? (raw as string[]) : [String(raw)];
  const cookie = cookies.find((c) => c.startsWith('es_refresh='));
  if (!cookie) throw new Error('no refresh cookie');
  return cookie.split(';')[0]!;
}

describe('auth (e2e)', () => {
  let t: TestApp;
  let fx: Fixtures;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    fx = await seedFixtures(t.prisma);
  });

  const login = (email: string, password = TEST_PASSWORD) =>
    t.http().post('/api/v1/auth/login').send({ email, password });

  it('logs in, returns an access token and sets a hardened refresh cookie', async () => {
    const res = await login('SALES@test.local').expect(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.user).toMatchObject({ email: 'sales@test.local', roles: ['SALES_USER'] });

    const cookie = (res.headers['set-cookie'] as unknown as string[]).join(';');
    expect(cookie).toMatch(/es_refresh=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);

    const me = await t
      .http()
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${res.body.accessToken}`)
      .expect(200);
    expect(me.body.id).toBe(fx.users.sales.id);

    const audit = await t.prisma.auditLog.findMany({ where: { action: 'auth.login' } });
    expect(audit).toHaveLength(1);
  });

  it('rejects wrong passwords and unknown emails with the same message', async () => {
    const wrong = await login('sales@test.local', 'nope').expect(401);
    const unknown = await login('ghost@test.local').expect(401);
    expect(wrong.body.message).toBe(unknown.body.message);
  });

  it('validates the login body', async () => {
    const res = await t.http().post('/api/v1/auth/login').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
  });

  it('locks the account after repeated failures (LOGIN_MAX_FAILURES=3 in tests)', async () => {
    for (let i = 0; i < 3; i++) await login('sales@test.local', 'wrong').expect(401);
    // Correct password is now refused while locked.
    await login('sales@test.local').expect(401);
    const user = await t.prisma.user.findUniqueOrThrow({ where: { id: fx.users.sales.id } });
    expect(user.lockedUntil).not.toBeNull();
    expect(await t.prisma.auditLog.count({ where: { action: 'auth.account_locked' } })).toBe(1);
  });

  it('rotates refresh tokens and revokes the family when an old token is reused', async () => {
    const first = refreshCookie(await login('sales@test.local').expect(200));

    const r1 = await t.http().post('/api/v1/auth/refresh').set('Cookie', first).expect(200);
    const second = refreshCookie(r1);
    expect(second).not.toBe(first);

    // Replay of the rotated token → rejected and the whole family is revoked…
    await t.http().post('/api/v1/auth/refresh').set('Cookie', first).expect(401);
    // …so the newest token is dead too (and using it is also logged as reuse).
    await t.http().post('/api/v1/auth/refresh').set('Cookie', second).expect(401);
    expect(
      await t.prisma.auditLog.count({ where: { action: 'auth.refresh_reuse_detected' } }),
    ).toBe(2);
    expect(await t.prisma.refreshToken.count({ where: { revokedAt: null } })).toBe(0);
  });

  it('logs out and invalidates the refresh token', async () => {
    const cookie = refreshCookie(await login('sales@test.local').expect(200));
    await t.http().post('/api/v1/auth/logout').set('Cookie', cookie).expect(204);
    await t.http().post('/api/v1/auth/refresh').set('Cookie', cookie).expect(401);
  });

  it('rejects tampered or missing access tokens', async () => {
    const token = (await login('sales@test.local').expect(200)).body.accessToken as string;
    const tampered = `${token.slice(0, -4)}AAAA`;
    const bad = await t.http().get('/api/v1/auth/me').set('Authorization', `Bearer ${tampered}`);
    expect(bad.status).toBe(401);
    const missing = await t.http().get('/api/v1/auth/me');
    expect(missing.status).toBe(401);
  });
});
