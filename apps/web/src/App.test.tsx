import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { mockApi, renderRoute, salesSession, urlOf } from './test/render';

const emptyPage = { items: [], total: 0, page: 1, pageSize: 15 };

describe('authentication flow', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('redirects to the login page when there is no session', async () => {
    mockApi({ 'POST /api/v1/auth/refresh': { status: 401, body: { message: 'No session' } } });
    renderRoute('/invoices');
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('shows an error for invalid credentials', async () => {
    mockApi({
      'POST /api/v1/auth/refresh': { status: 401 },
      'POST /api/v1/auth/login': { status: 401, body: { message: 'Invalid email or password' } },
    });
    renderRoute('/login');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/email/i), 'sales@test.local');
    await user.type(screen.getByLabelText(/^password/i, { selector: 'input' }), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password');
  });

  it('signs in and lands on the invoice list', async () => {
    const fetchMock = mockApi({
      'POST /api/v1/auth/refresh': { status: 401 },
      'POST /api/v1/auth/login': { body: salesSession },
      'GET /api/v1/invoices': { body: emptyPage },
      'GET /api/v1/customers': { body: [] },
    });
    renderRoute('/login');
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/email/i), 'sales@test.local');
    await user.type(screen.getByLabelText(/^password/i, { selector: 'input' }), 'secret-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: 'Sales invoices' })).toBeInTheDocument();
    expect(await screen.findByText('No invoices match these filters.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New invoice' })).toBeInTheDocument();

    await waitFor(() => {
      const listCall = fetchMock.mock.calls.find(([url]) =>
        urlOf(url).startsWith('/api/v1/invoices'),
      );
      expect(listCall).toBeDefined();
      const headers = new Headers(listCall![1]?.headers);
      expect(headers.get('Authorization')).toBe('Bearer test-token');
    });
  });

  it('hides "New invoice" for users without a sales role', async () => {
    mockApi({
      'POST /api/v1/auth/refresh': {
        body: { ...salesSession, user: { ...salesSession.user, roles: ['CHANGE_APPROVER'] } },
      },
      'GET /api/v1/invoices': { body: emptyPage },
      'GET /api/v1/customers': { body: [] },
    });
    renderRoute('/invoices');
    expect(await screen.findByText('No invoices match these filters.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New invoice' })).not.toBeInTheDocument();
  });
});
