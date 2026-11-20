import type { AddressInfo } from 'node:net';
import { recordTransition } from '@evolvesales/db';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SOCKET_PATH } from '../src/configure-app.js';
import {
  createTestApp,
  type Fixtures,
  loginAs,
  resetDatabase,
  seedFixtures,
  type TestApp,
} from './helpers.js';
import { sampleProposal } from './scripted-model.js';

const API = '/api/v1';

interface NotificationList {
  items: Array<{ id: string; type: string; title: string; readAt: string | null }>;
  unreadCount: number;
}

describe('notifications and realtime (e2e)', () => {
  let t: TestApp;
  let fx: Fixtures;
  let url: string;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    t = await createTestApp({}, { listen: true });
    const address = t.app.getHttpServer().address() as AddressInfo;
    url = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    for (const s of sockets) s.disconnect();
    await t.close();
  });
  beforeEach(async () => {
    await resetDatabase(t.prisma);
    fx = await seedFixtures(t.prisma);
  });

  async function awaitingApproval(): Promise<string> {
    return t.prisma.$transaction(async (tx) => {
      const cr = await tx.changeRequest.create({
        data: {
          key: 'CR-0042',
          title: sampleProposal.title,
          requesterId: fx.users.sales.id,
          screen: sampleProposal.screen,
          originalRequest: 'x',
          structured: sampleProposal,
          status: 'AWAITING_APPROVAL',
        },
      });
      // A SYSTEM transition into AWAITING_APPROVAL notifies the approvers and admins.
      await recordTransition(tx, cr, 'ANALYZING', {
        to: 'AWAITING_APPROVAL',
        actor: { type: 'SYSTEM' },
      });
      return cr.id;
    });
  }

  const connect = (token: string | null) =>
    new Promise<Socket>((resolve, reject) => {
      const socket = io(url, {
        path: SOCKET_PATH,
        auth: token ? { token } : {},
        transports: ['websocket'],
        reconnection: false,
      });
      sockets.push(socket);
      socket.on('connect', () => resolve(socket));
      socket.on('connect_error', reject);
    });

  it('lists only the user’s own notifications and marks them read', async () => {
    await awaitingApproval();
    const approver = await loginAs(t, fx.users.approver.email);
    const sales = await loginAs(t, fx.users.sales.email);

    const list = await t.http().get(`${API}/notifications`).auth(approver, { type: 'bearer' });
    const body = list.body as NotificationList;
    expect(body.unreadCount).toBe(1);
    expect(body.items[0]).toMatchObject({
      type: 'cr.awaiting_approval',
      title: 'CR-0042 needs your approval',
    });
    const id = body.items[0]?.id ?? '';

    // Another user cannot mark it read.
    expect(
      (await t.http().post(`${API}/notifications/${id}/read`).auth(sales, { type: 'bearer' }))
        .status,
    ).toBe(404);

    expect(
      (await t.http().post(`${API}/notifications/${id}/read`).auth(approver, { type: 'bearer' }))
        .status,
    ).toBe(204);
    const after = (await t.http().get(`${API}/notifications`).auth(approver, { type: 'bearer' }))
      .body as NotificationList;
    expect(after.unreadCount).toBe(0);
  });

  it('pushes cr.updated to the requester over Socket.IO after commit', async () => {
    const token = await loginAs(t, fx.users.sales.email);
    const socket = await connect(token);
    const received = new Promise<{ changeRequestId: string; status: string }>((resolve) =>
      socket.once('cr.updated', resolve),
    );

    const id = await awaitingApproval();

    await expect(received).resolves.toEqual({ changeRequestId: id, status: 'AWAITING_APPROVAL' });
  });

  it('disconnects sockets without a valid token', async () => {
    // The server may drop the socket before the client sees `connect`, so listen from the start.
    const socket = io(url, {
      path: SOCKET_PATH,
      auth: { token: 'not-a-jwt' },
      transports: ['websocket'],
      reconnection: false,
    });
    sockets.push(socket);
    const rejected = await new Promise<string>((resolve) => {
      socket.once('unauthorized', () => resolve('unauthorized'));
      socket.once('disconnect', () => resolve('disconnect'));
    });
    expect(['unauthorized', 'disconnect']).toContain(rejected);
    await new Promise((r) => setTimeout(r, 200));
    expect(socket.connected).toBe(false);
  });
});
