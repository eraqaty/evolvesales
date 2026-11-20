import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonBody, mockApi, renderRoute, salesSession, urlOf } from '../../test/render';

const customers = [{ id: 'c-1', code: 'C-0001', name: 'Nile Valley Trading Co.' }];
const products = [
  {
    id: 'p-1',
    sku: 'P-1001',
    name: 'Laptop',
    unit: 'pcs',
    unitPrice: '1000.00',
    taxRate: '0.1400',
  },
];

type User = ReturnType<typeof userEvent.setup>;

/** Mantine Select: type to open + filter, then click the option once the data has arrived. */
async function pickOption(user: User, input: HTMLElement, text: string, option: string | RegExp) {
  await user.click(input);
  await user.type(input, text);
  await user.click(await screen.findByRole('option', { name: option }));
}

describe('InvoiceEditorPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function openEditor() {
    const fetchMock = mockApi({
      'POST /api/v1/auth/refresh': { body: salesSession },
      'GET /api/v1/customers': { body: customers },
      'GET /api/v1/products': { body: products },
      'POST /api/v1/invoices': (_url, init) => {
        const body = jsonBody(init);
        return {
          status: 201,
          body: { id: 'inv-1', number: 'INV-2026-000001', version: 0, ...body },
        };
      },
      'GET /api/v1/invoices/inv-1': { status: 404 },
    });
    renderRoute('/invoices/new');
    await screen.findByRole('heading', { name: 'New sales invoice' });
    return fetchMock;
  }

  it('validates before submitting', async () => {
    const fetchMock = await openEditor();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Save draft' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Select a customer.');
    expect(alert).toHaveTextContent('Line 1: select a product.');
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST' && init.body)).toBe(
      false,
    );
  });

  it('fills the unit price from the product and previews totals with tax', async () => {
    await openEditor();
    const user = userEvent.setup();

    await pickOption(
      user,
      screen.getByLabelText('Line 1 product', { selector: 'input' }),
      'Lap',
      'Laptop (P-1001)',
    );

    const qty = screen.getByRole('textbox', { name: 'Line 1 quantity' });
    await user.clear(qty);
    await user.type(qty, '2');

    // 2 × 1000 = 2000; tax 14 % = 280; total 2280
    await waitFor(() =>
      expect(screen.getByTestId('total-Total (EGP)')).toHaveTextContent('2,280.00'),
    );
    expect(screen.getByTestId('total-Tax')).toHaveTextContent('280.00');
    expect(within(screen.getByRole('table')).getByText('14%')).toBeInTheDocument();
  });

  it('sends a normalised body to the API when saving', async () => {
    const fetchMock = await openEditor();
    const user = userEvent.setup();

    await pickOption(
      user,
      screen.getByLabelText(/^customer/i, { selector: 'input' }),
      'Nile',
      /Nile Valley/,
    );
    await pickOption(
      user,
      screen.getByLabelText('Line 1 product', { selector: 'input' }),
      'Lap',
      'Laptop (P-1001)',
    );
    await user.click(screen.getByRole('button', { name: 'Save draft' }));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        ([url, init]) => urlOf(url) === '/api/v1/invoices' && init?.method === 'POST',
      );
      expect(post).toBeDefined();
      const body = jsonBody(post![1]);
      expect(body).toMatchObject({
        customerId: 'c-1',
        headerDiscountPct: 0,
        items: [{ productId: 'p-1', quantity: 1, unitPrice: '1000.00', lineDiscountPct: 0 }],
      });
      expect(body).not.toHaveProperty('taxRate');
    });
  });
});
