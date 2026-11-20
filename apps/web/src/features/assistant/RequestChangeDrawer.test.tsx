import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ChangeRequestProposal, ConversationDto } from '@evolvesales/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonBody, mockApi, renderRoute, salesSession, urlOf } from '../../test/render';

const emptyPage = { items: [], total: 0, page: 1, pageSize: 15 };
const proposal: ChangeRequestProposal = {
  title: 'Export invoice list to Excel',
  category: 'feature',
  description: 'Add an export button.',
  screen: 'sales.invoices.list',
  userStory: 'As a sales user I want to export invoices.',
  acceptanceCriteria: ['Exports the filtered rows'],
  outOfScope: [],
  priority: 'MEDIUM',
  assumptions: ['XLSX format'],
};
const conversation = (over: Partial<ConversationDto> = {}): ConversationDto => ({
  id: 'conv-1',
  screen: 'sales.invoices.list',
  status: 'OPEN',
  changeRequestId: null,
  changeRequestKey: null,
  proposal: null,
  pendingClarification: null,
  messages: [],
  userMessageCount: 0,
  ...over,
});

const base = {
  'POST /api/v1/auth/refresh': { body: salesSession },
  'GET /api/v1/invoices': { body: emptyPage },
  'GET /api/v1/customers': { body: [] },
  'GET /api/v1/notifications': { body: { items: [], unreadCount: 0 } },
};

describe('Request a change drawer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the screen context, streams the reply, shows the summary card and submits', async () => {
    let current = conversation();
    const fetchMock = mockApi({
      ...base,
      'GET /api/v1/assistant/status': {
        body: { configured: true, provider: 'anthropic', model: 'm' },
      },
      'POST /api/v1/assistant/conversations': () => ({ status: 201, body: current }),
      'GET /api/v1/assistant/conversations/conv-1': () => ({ body: current }),
      'POST /api/v1/assistant/conversations/conv-1/messages': () => {
        current = conversation({
          proposal,
          userMessageCount: 1,
          messages: [
            { id: 'm1', role: 'user', content: 'Export please', createdAt: '' },
            { id: 'm2', role: 'assistant', content: 'Please review and submit.', createdAt: '' },
          ],
        });
        return {
          sse: [
            { type: 'tool', name: 'propose_change_request' },
            { type: 'proposal', proposal },
            { type: 'text', delta: 'Please review and submit.' },
            { type: 'done', messageId: 'm2' },
          ],
        };
      },
      'POST /api/v1/assistant/conversations/conv-1/submit': () => {
        current = {
          ...current,
          status: 'SUBMITTED',
          changeRequestId: 'cr-1',
          changeRequestKey: 'CR-0001',
        };
        return {
          status: 201,
          body: { changeRequestId: 'cr-1', key: 'CR-0001', status: 'SUBMITTED' },
        };
      },
    });
    renderRoute('/invoices?status=DRAFT');
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /request a change/i }));
    const drawer = await screen.findByRole('dialog');
    expect(
      await within(drawer).findByText(/Context: Invoice list \(status=DRAFT/),
    ).toBeInTheDocument();

    const start = fetchMock.mock.calls.find(
      ([u, init]) => urlOf(u).endsWith('/assistant/conversations') && init?.method === 'POST',
    );
    expect(jsonBody(start?.[1])).toMatchObject({
      screenContext: { screen: 'sales.invoices.list', filters: { status: 'DRAFT' } },
    });

    await user.type(within(drawer).getByLabelText('Message to the assistant'), 'Export please');
    await user.click(within(drawer).getByRole('button', { name: 'Send' }));

    const card = await within(drawer).findByLabelText('Request summary');
    expect(card).toHaveTextContent('Export invoice list to Excel');
    expect(await within(drawer).findByText('Please review and submit.')).toBeInTheDocument();

    await user.click(within(drawer).getByRole('button', { name: 'Submit request' }));
    expect(await within(drawer).findByText('Submitted as CR-0001')).toBeInTheDocument();
    expect(within(drawer).getByRole('link', { name: 'Track CR-0001' })).toHaveAttribute(
      'href',
      '/requests/cr-1',
    );
  });

  it('tells the user when the assistant is not configured and disables input', async () => {
    mockApi({
      ...base,
      'GET /api/v1/assistant/status': {
        body: { configured: false, provider: 'anthropic', model: 'm' },
      },
      'POST /api/v1/assistant/conversations': { status: 201, body: conversation() },
      'GET /api/v1/assistant/conversations/conv-1': { body: conversation() },
    });
    renderRoute('/invoices');
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /request a change/i }));
    const drawer = await screen.findByRole('dialog');

    expect(
      await within(drawer).findByText('The AI assistant is not configured'),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(within(drawer).getByLabelText('Message to the assistant')).toBeDisabled(),
    );
  });

  it('shows a server error from the stream without inventing an answer', async () => {
    mockApi({
      ...base,
      'GET /api/v1/assistant/status': {
        body: { configured: true, provider: 'anthropic', model: 'm' },
      },
      'POST /api/v1/assistant/conversations': { status: 201, body: conversation() },
      'GET /api/v1/assistant/conversations/conv-1': { body: conversation() },
      'POST /api/v1/assistant/conversations/conv-1/messages': {
        sse: [
          { type: 'error', message: 'The assistant could not answer right now. Please try again.' },
        ],
      },
    });
    renderRoute('/invoices');
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /request a change/i }));
    const drawer = await screen.findByRole('dialog');
    await user.type(await within(drawer).findByLabelText('Message to the assistant'), 'hello');
    await user.click(within(drawer).getByRole('button', { name: 'Send' }));

    expect(await within(drawer).findByText(/could not answer right now/)).toBeInTheDocument();
    expect(within(drawer).queryByLabelText('Request summary')).not.toBeInTheDocument();
  });
});
