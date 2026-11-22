import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AgentSettingsDto, RepositoryDto } from '@evolvesales/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonBody, mockApi, renderRoute, salesSession, urlOf } from '../../test/render';

const adminSession = {
  ...salesSession,
  user: { id: 'u-admin', email: 'admin@test', displayName: 'Ada Admin', roles: ['ADMIN'] },
};
const base = {
  'GET /api/v1/notifications': { body: { items: [], unreadCount: 0 } },
  'POST /api/v1/auth/refresh': { body: adminSession },
};
const unset: AgentSettingsDto = {
  analyzeMaxBudgetUsd: null,
  dailyBudgetUsd: null,
  spentTodayUsd: '0.00',
  updatedAt: null,
  updatedBy: null,
};
const repo = (over: Partial<RepositoryDto> = {}): RepositoryDto => ({
  id: 'r-1',
  fullName: 'eraqaty/evolvesales',
  defaultBranch: 'main',
  isPrivate: false,
  isAuthorized: false,
  authorizedBy: null,
  authorizedAt: null,
  removedAt: null,
  lastSyncedAt: '2026-11-22T10:00:00.000Z',
  ...over,
});

describe('agents admin page', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('warns while caps are unset and saves validated caps', async () => {
    const fetchMock = mockApi({
      ...base,
      'GET /api/v1/admin/agent-settings': { body: unset },
      'GET /api/v1/admin/repositories': { body: [] },
      'PUT /api/v1/admin/agent-settings': (_u, init) => ({
        body: { ...unset, ...jsonBody(init), spentTodayUsd: '0.00' },
      }),
    });
    renderRoute('/admin/agents');
    const user = userEvent.setup();

    expect(await screen.findByText('Caps not set')).toBeInTheDocument();
    const perJob = screen.getByLabelText(/Per analysis job/);
    const daily = screen.getByLabelText(/Per day/);
    await user.type(perJob, '10');
    await user.type(daily, '5');
    await user.click(screen.getByRole('button', { name: 'Save caps' }));
    expect(await screen.findByText(/at least the per-job cap/)).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, i]) => i?.method === 'PUT')).toBe(false);

    await user.clear(daily);
    await user.type(daily, '20');
    await user.click(screen.getByRole('button', { name: 'Save caps' }));
    expect(await screen.findByText('Caps saved.')).toBeInTheDocument();
    const put = fetchMock.mock.calls.find(([, i]) => i?.method === 'PUT');
    expect(jsonBody(put?.[1])).toEqual({ analyzeMaxBudgetUsd: '10.00', dailyBudgetUsd: '20.00' });
    expect(screen.queryByText('Caps not set')).not.toBeInTheDocument();
  });

  it('authorizes a repository and requests a refresh', async () => {
    let authorized = false;
    const fetchMock = mockApi({
      ...base,
      'GET /api/v1/admin/agent-settings': { body: unset },
      'GET /api/v1/admin/repositories': () => ({
        body: [
          repo({ isAuthorized: authorized }),
          repo({ id: 'r-2', fullName: 'eraqaty/old', removedAt: '2026-11-21T00:00:00.000Z' }),
        ],
      }),
      'PUT /api/v1/admin/repositories/r-1/authorization': (_u, init) => {
        authorized = jsonBody(init).authorized === true;
        return { body: repo({ isAuthorized: authorized }) };
      },
      'POST /api/v1/admin/repositories/sync': { status: 202, body: { queued: true } },
    });
    renderRoute('/admin/agents');
    const user = userEvent.setup();

    const row = (await screen.findByText('eraqaty/evolvesales')).closest('tr');
    if (!row) throw new Error('row not found');
    await user.click(within(row).getByRole('button', { name: 'Authorize' }));
    expect(await within(row).findByText('Authorized')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Revoke' })).toBeInTheDocument();

    const removed = screen.getByText('eraqaty/old').closest('tr');
    if (!removed) throw new Error('row not found');
    expect(within(removed).getByText('App removed')).toBeInTheDocument();
    expect(within(removed).queryByRole('button')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Refresh from GitHub' }));
    expect(await screen.findByText(/Refresh requested/)).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([u]) => urlOf(u).endsWith('/admin/repositories/sync'))).toBe(
      true,
    );
  });

  it('is not available to non-admins', async () => {
    mockApi({ ...base, 'POST /api/v1/auth/refresh': { body: salesSession } });
    renderRoute('/admin/agents');
    expect(await screen.findByText(/Only administrators/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Agents' })).not.toBeInTheDocument();
  });
});
