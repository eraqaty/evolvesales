import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { InvoiceDetailDto } from '@evolvesales/shared';
import {
  createTestApp,
  type Fixtures,
  loginAs,
  resetDatabase,
  seedFixtures,
  type TestApp,
} from './helpers.js';

const API = '/api/v1';

describe('invoices (e2e)', () => {
  let t: TestApp;
  let fx: Fixtures;
  let tokens: Record<keyof Fixtures['users'], string>;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    fx = await seedFixtures(t.prisma);
    tokens = {
      sales: await loginAs(t, fx.users.sales.email),
      sales2: await loginAs(t, fx.users.sales2.email),
      manager: await loginAs(t, fx.users.manager.email),
      approver: await loginAs(t, fx.users.approver.email),
      admin: await loginAs(t, fx.users.admin.email),
    };
  });

  const as = (who: keyof Fixtures['users']) => ({
    get: (url: string) =>
      t
        .http()
        .get(API + url)
        .set('Authorization', `Bearer ${tokens[who]}`),
    post: (url: string, body?: object) =>
      t
        .http()
        .post(API + url)
        .set('Authorization', `Bearer ${tokens[who]}`)
        .send(body ?? {}),
    put: (url: string, body: object) =>
      t
        .http()
        .put(API + url)
        .set('Authorization', `Bearer ${tokens[who]}`)
        .send(body),
  });

  const draftBody = () => ({
    customerId: fx.customers.active,
    issueDate: '2026-11-20',
    dueDate: '2026-12-20',
    headerDiscountPct: 10,
    notes: 'First order',
    items: [
      { productId: fx.products.laptop, quantity: 2, unitPrice: '1000.00', lineDiscountPct: 5 },
      { productId: fx.products.book, quantity: '3', unitPrice: 50 },
    ],
  });

  async function createDraft(who: keyof Fixtures['users'] = 'sales'): Promise<InvoiceDetailDto> {
    const res = await as(who).post('/invoices', draftBody());
    expect(res.status).toBe(201);
    return res.body as InvoiceDetailDto;
  }

  describe('create', () => {
    it('creates a numbered draft with server-calculated totals and an audit record', async () => {
      const inv = await createDraft();
      // laptop: 2000 − 5 % = 1900; book: 150 → net 2050; header 10 % → 190 / 15
      // taxable 1710 (14 % = 239.40) + 135 (0 %) → grand 2084.40
      expect(inv).toMatchObject({
        number: 'INV-2026-000001',
        status: 'DRAFT',
        currency: 'EGP',
        subtotal: '2150.00',
        discountTotal: '305.00',
        taxableTotal: '1845.00',
        taxTotal: '239.40',
        grandTotal: '2084.40',
        version: 0,
        createdBy: { id: fx.users.sales.id },
      });
      expect(inv.items.map((i) => i.taxRate)).toEqual(['0.1400', '0.0000']);

      const audit = await t.prisma.auditLog.findMany({ where: { entityId: inv.id } });
      expect(audit.map((a) => a.action)).toEqual(['invoice.created']);
      expect(audit[0]!.actorId).toBe(fx.users.sales.id);
    });

    it('allocates unique sequential numbers under concurrency', async () => {
      const results = await Promise.all(
        Array.from({ length: 8 }, () => as('sales').post('/invoices', draftBody())),
      );
      expect(results.every((r) => r.status === 201)).toBe(true);
      const numbers = results.map((r) => (r.body as InvoiceDetailDto).number).sort();
      expect(numbers).toEqual(
        Array.from({ length: 8 }, (_, i) => `INV-2026-${String(i + 1).padStart(6, '0')}`),
      );
    });

    it('ignores a client-supplied tax rate and always uses the product rate', async () => {
      const body = draftBody();
      (body.items[0] as Record<string, unknown>).taxRate = '0';
      const res = await as('sales').post('/invoices', body).expect(201);
      expect((res.body as InvoiceDetailDto).items[0]!.taxRate).toBe('0.1400');
    });

    it('rejects invalid bodies with 400', async () => {
      const res = await as('sales').post('/invoices', {
        ...draftBody(),
        dueDate: '2026-01-01',
        items: [{ productId: fx.products.laptop, quantity: -1, unitPrice: '1.001' }],
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body.message)).toMatch(/dueDate/);
    });

    it('rejects inactive customers and products with 422', async () => {
      await as('sales')
        .post('/invoices', { ...draftBody(), customerId: fx.customers.inactive })
        .expect(422);
      await as('sales')
        .post('/invoices', {
          ...draftBody(),
          items: [{ productId: fx.products.discontinued, quantity: 1, unitPrice: 10 }],
        })
        .expect(422);
    });

    it('forbids users without a sales role', async () => {
      await as('approver').post('/invoices', draftBody()).expect(403);
      await as('admin').post('/invoices', draftBody()).expect(201);
    });
  });

  describe('list and details', () => {
    it('searches, filters and paginates', async () => {
      const a = await createDraft();
      await createDraft();
      await as('sales').post(`/invoices/${a.id}/confirm`, { version: 0 }).expect(200);

      const all = await as('approver').get('/invoices?pageSize=1&page=2').expect(200);
      expect(all.body).toMatchObject({ total: 2, page: 2, pageSize: 1 });
      expect(all.body.items).toHaveLength(1);

      const confirmed = await as('sales').get('/invoices?status=CONFIRMED').expect(200);
      expect(confirmed.body.items.map((i: { id: string }) => i.id)).toEqual([a.id]);

      const byCustomer = await as('sales').get('/invoices?search=nile').expect(200);
      expect(byCustomer.body.total).toBe(2);
      const byNumber = await as('sales').get('/invoices?search=000001').expect(200);
      expect(byNumber.body.total).toBe(1);

      await as('sales').get('/invoices?status=PAID').expect(400);
    });

    it('returns 404 for unknown ids and 400 for malformed ids', async () => {
      await as('sales').get('/invoices/0195f0a0-0000-7000-8000-000000000000').expect(404);
      await as('sales').get('/invoices/not-a-uuid').expect(400);
    });
  });

  describe('edit', () => {
    it('lets the creator edit a draft and bumps the version', async () => {
      const inv = await createDraft();
      const res = await as('sales')
        .put(`/invoices/${inv.id}`, {
          ...draftBody(),
          version: 0,
          headerDiscountPct: 0,
          items: [{ productId: fx.products.coffee, quantity: 1, unitPrice: '200.00' }],
        })
        .expect(200);
      expect(res.body).toMatchObject({ version: 1, grandTotal: '210.00', number: inv.number });
      expect(res.body.items).toHaveLength(1);
    });

    it('rejects stale versions with 409', async () => {
      const inv = await createDraft();
      await as('sales')
        .put(`/invoices/${inv.id}`, { ...draftBody(), version: 0 })
        .expect(200);
      await as('sales')
        .put(`/invoices/${inv.id}`, { ...draftBody(), version: 0 })
        .expect(409);
    });

    it('allows only the creator or a manager to edit', async () => {
      const inv = await createDraft();
      await as('sales2')
        .put(`/invoices/${inv.id}`, { ...draftBody(), version: 0 })
        .expect(403);
      await as('manager')
        .put(`/invoices/${inv.id}`, { ...draftBody(), version: 0 })
        .expect(200);
    });

    it('does not allow moving an invoice to another year', async () => {
      const inv = await createDraft();
      await as('sales')
        .put(`/invoices/${inv.id}`, {
          ...draftBody(),
          version: 0,
          issueDate: '2027-01-02',
          dueDate: undefined,
        })
        .expect(422);
    });
  });

  describe('confirm and cancel', () => {
    it('confirms a draft, after which it cannot be edited', async () => {
      const inv = await createDraft();
      const res = await as('sales2')
        .post(`/invoices/${inv.id}/confirm`, { version: 0 })
        .expect(200);
      expect(res.body).toMatchObject({
        status: 'CONFIRMED',
        confirmedBy: { id: fx.users.sales2.id },
      });
      await as('sales')
        .put(`/invoices/${inv.id}`, { ...draftBody(), version: 1 })
        .expect(409);
      await as('sales').post(`/invoices/${inv.id}/confirm`, { version: 1 }).expect(409);
    });

    it('refuses to confirm an empty draft', async () => {
      const res = await as('sales')
        .post('/invoices', { ...draftBody(), items: [] })
        .expect(201);
      await as('sales').post(`/invoices/${res.body.id}/confirm`, { version: 0 }).expect(422);
    });

    it('cancels drafts freely but needs a manager and a reason for confirmed invoices', async () => {
      const draft = await createDraft();
      await as('sales').post(`/invoices/${draft.id}/cancel`, { version: 0 }).expect(200);

      const inv = await createDraft();
      await as('sales').post(`/invoices/${inv.id}/confirm`, { version: 0 }).expect(200);
      await as('sales')
        .post(`/invoices/${inv.id}/cancel`, { version: 1, reason: 'Customer returned goods' })
        .expect(403);
      await as('manager').post(`/invoices/${inv.id}/cancel`, { version: 1 }).expect(422);
      const res = await as('manager')
        .post(`/invoices/${inv.id}/cancel`, { version: 1, reason: 'Customer returned goods' })
        .expect(200);
      expect(res.body).toMatchObject({
        status: 'CANCELLED',
        cancelReason: 'Customer returned goods',
      });

      await as('admin')
        .post(`/invoices/${inv.id}/cancel`, { version: 2, reason: 'again' })
        .expect(409);

      const actions = await t.prisma.auditLog.findMany({
        where: { entityId: inv.id },
        orderBy: { id: 'asc' },
        select: { action: true },
      });
      expect(actions.map((a) => a.action)).toEqual([
        'invoice.created',
        'invoice.confirmed',
        'invoice.cancelled',
      ]);
    });
  });

  describe('lookups', () => {
    it('lists only active customers and products', async () => {
      const customers = await as('sales').get('/customers').expect(200);
      expect(customers.body.map((c: { code: string }) => c.code)).toEqual(['C-1']);
      const products = await as('sales').get('/products?search=lap').expect(200);
      expect(products.body).toEqual([
        expect.objectContaining({ sku: 'P-1', unitPrice: '1000.00', taxRate: '0.1400' }),
      ]);
    });
  });
});
