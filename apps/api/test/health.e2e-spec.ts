import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers.js';

describe('GET /api/v1/health (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.close();
  });

  it('is public and returns status ok', async () => {
    const res = await t.http().get('/api/v1/health').expect(200);
    expect(res.body).toMatchObject({ status: 'ok', service: 'api' });
  });

  it('echoes a correlation id and sets security headers', async () => {
    const res = await t.http().get('/api/v1/health').set('x-correlation-id', 'test-corr-1234');
    expect(res.headers['x-correlation-id']).toBe('test-corr-1234');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('does not serve routes outside the api prefix', async () => {
    const res = await t.http().get('/health');
    expect(res.status).toBe(404);
  });

  it('requires authentication for everything else', async () => {
    const res = await t.http().get('/api/v1/invoices');
    expect(res.status).toBe(401);
  });
});
