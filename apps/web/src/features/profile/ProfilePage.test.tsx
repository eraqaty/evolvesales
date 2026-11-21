import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { WhatsAppProfileDto } from '@evolvesales/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonBody, mockApi, renderRoute, salesSession, urlOf } from '../../test/render';

const approverSession = {
  ...salesSession,
  user: { id: 'u-appr', email: 'a@test', displayName: 'Amr Approver', roles: ['CHANGE_APPROVER'] },
};

const profile = (over: Partial<WhatsAppProfileDto> = {}): WhatsAppProfileDto => ({
  enabled: true,
  botNumber: '+15550001111',
  phone: null,
  verifiedAt: null,
  pending: null,
  hasApprovalPin: false,
  pinLockedUntil: null,
  canApprove: false,
  prefs: { statusChanged: true, awaitingApproval: true, clarificationNeeded: true },
  ...over,
});

const base = { 'GET /api/v1/notifications': { body: { items: [], unreadCount: 0 } } };

describe('profile page', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('validates the number and shows the code to send from the phone', async () => {
    const fetchMock = mockApi({
      ...base,
      'POST /api/v1/auth/refresh': { body: salesSession },
      'GET /api/v1/profile/whatsapp': { body: profile() },
      'POST /api/v1/profile/whatsapp/link': {
        body: {
          code: '482915',
          phone: '+201001234567',
          expiresAt: '2026-11-20T12:10:00.000Z',
          botNumber: '+15550001111',
          waLink: 'https://wa.me/15550001111?text=LINK%20482915',
        },
      },
    });
    renderRoute('/profile');
    const user = userEvent.setup();

    const input = await screen.findByLabelText('Your WhatsApp number');
    await user.type(input, '01001234567');
    await user.click(screen.getByRole('button', { name: 'Get link code' }));
    expect(await screen.findByText(/international format/)).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([u]) => urlOf(u).endsWith('/whatsapp/link'))).toBe(false);

    await user.clear(input);
    await user.type(input, '+201001234567');
    await user.click(screen.getByRole('button', { name: 'Get link code' }));
    expect(await screen.findByText('LINK 482915')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Open WhatsApp/ })).toHaveAttribute(
      'href',
      'https://wa.me/15550001111?text=LINK%20482915',
    );
    const call = fetchMock.mock.calls.find(([u]) => urlOf(u).endsWith('/whatsapp/link'));
    expect(jsonBody(call?.[1])).toEqual({ phone: '+201001234567' });
    // Approval PIN settings are only for approvers.
    expect(screen.queryByText('Approval PIN')).not.toBeInTheDocument();
  });

  it('lets an approver set a 6-digit PIN with their password', async () => {
    const fetchMock = mockApi({
      ...base,
      'POST /api/v1/auth/refresh': { body: approverSession },
      'GET /api/v1/profile/whatsapp': {
        body: profile({
          canApprove: true,
          phone: '+201000000002',
          verifiedAt: '2026-11-20T10:00:00Z',
        }),
      },
      'PUT /api/v1/profile/approval-pin': { status: 204 },
    });
    renderRoute('/profile');
    const user = userEvent.setup();

    expect(await screen.findByText('+201000000002')).toBeInTheDocument();
    const save = screen.getByRole('button', { name: 'Save PIN' });
    await user.type(screen.getByLabelText('PIN'), '48a2915');
    expect(save).toBeDisabled();
    await user.type(screen.getByLabelText('Your password'), 'secret-password');
    await user.click(save);

    expect(await screen.findByText('Approval PIN saved.')).toBeInTheDocument();
    const call = fetchMock.mock.calls.find(([u]) => urlOf(u).endsWith('/approval-pin'));
    expect(jsonBody(call?.[1])).toEqual({ pin: '482915', currentPassword: 'secret-password' });
    expect(screen.getByText('WhatsApp notifications')).toBeInTheDocument();
  });
});
