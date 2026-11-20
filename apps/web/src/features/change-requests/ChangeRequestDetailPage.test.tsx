import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ChangeRequestDetailDto } from '@evolvesales/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonBody, mockApi, renderRoute, salesSession, urlOf } from '../../test/render';

const approverSession = {
  ...salesSession,
  user: { id: 'u-appr', email: 'a@test', displayName: 'Amr Approver', roles: ['CHANGE_APPROVER'] },
};

const detail = (over: Partial<ChangeRequestDetailDto> = {}): ChangeRequestDetailDto => ({
  id: 'cr-1',
  key: 'CR-0001',
  title: 'Export invoice list to Excel',
  status: 'AWAITING_APPROVAL',
  priority: 'MEDIUM',
  screen: 'sales.invoices.list',
  requester: { id: 'u-sales', displayName: 'Sara Sales' },
  createdAt: '2026-11-20T10:00:00.000Z',
  updatedAt: '2026-11-20T10:00:00.000Z',
  originalRequest: 'Export please',
  structured: {
    title: 'Export invoice list to Excel',
    category: 'feature',
    description: 'Add an export button.',
    screen: 'sales.invoices.list',
    userStory: 'As a sales user I want to export invoices.',
    acceptanceCriteria: ['Exports the filtered rows'],
    outOfScope: [],
    priority: 'MEDIUM',
    assumptions: [],
  },
  screenContext: null,
  conversationId: null,
  pendingQuestions: [],
  transitions: [],
  decisions: [],
  plans: [],
  jobs: [],
  allowedActions: [],
  ...over,
});

const base = { 'GET /api/v1/notifications': { body: { items: [], unreadCount: 0 } } };

describe('change request detail', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows no decision buttons when the server allows none', async () => {
    mockApi({
      ...base,
      'POST /api/v1/auth/refresh': { body: salesSession },
      'GET /api/v1/change-requests/cr-1': { body: detail() },
    });
    renderRoute('/requests/cr-1');

    expect(await screen.findByText('CR-0001')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();
    // Approvals navigation is only for approvers.
    expect(screen.queryByRole('link', { name: 'Approvals' })).not.toBeInTheDocument();
  });

  it('lets an approver reject only with a reason', async () => {
    const fetchMock = mockApi({
      ...base,
      'POST /api/v1/auth/refresh': { body: approverSession },
      'GET /api/v1/change-requests/cr-1': {
        body: detail({ allowedActions: ['approve', 'reject', 'clarify'] }),
      },
      'POST /api/v1/change-requests/cr-1/reject': {
        body: detail({ status: 'REJECTED', allowedActions: [] }),
      },
    });
    renderRoute('/requests/cr-1');
    const user = userEvent.setup();

    expect(await screen.findByRole('link', { name: 'Approvals' })).toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Reject' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Reject' });
    expect(confirm).toBeDisabled();

    await user.type(within(dialog).getByLabelText(/reason/i), 'Out of scope');
    await user.click(confirm);

    const call = fetchMock.mock.calls.find(([u]) => urlOf(u).endsWith('/cr-1/reject'));
    expect(jsonBody(call?.[1])).toEqual({ comment: 'Out of scope' });
  });

  it('shows the analysis failure reason instead of a plan', async () => {
    mockApi({
      ...base,
      'POST /api/v1/auth/refresh': { body: salesSession },
      'GET /api/v1/change-requests/cr-1': {
        body: detail({
          status: 'FAILED',
          transitions: [
            {
              id: 't1',
              from: 'ANALYZING',
              to: 'FAILED',
              actorType: 'SYSTEM',
              actor: null,
              reason: 'Analysis agent not configured',
              createdAt: '2026-11-20T10:01:00.000Z',
            },
          ],
        }),
      },
    });
    renderRoute('/requests/cr-1');

    const alert = (await screen.findByText('This request failed')).closest('[role="alert"]');
    expect(alert).toHaveTextContent('Analysis agent not configured');
    expect(screen.getByRole('tab', { name: 'Plan (0)' })).toBeInTheDocument();
  });
});
