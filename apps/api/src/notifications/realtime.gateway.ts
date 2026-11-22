import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { type OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { isRole, type RealtimeEvent } from '@evolvesales/shared';
import type { Server, Socket } from 'socket.io';
import type { AccessTokenPayload } from '../auth/auth.types.js';

/**
 * Socket.IO endpoint for live updates. Connections must present the same access JWT as REST
 * (`auth: { token }`); each socket joins only `user:<id>` and `role:<role>` rooms, so users
 * receive just their own events plus role-wide refresh hints. No business data is pushed:
 * clients re-fetch through the authorised REST API.
 */
@WebSocketGateway()
export class RealtimeGateway implements OnGatewayConnection {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(private readonly jwt: JwtService) {}

  async handleConnection(client: Socket): Promise<void> {
    const auth: unknown = client.handshake.auth;
    const token =
      typeof auth === 'object' && auth !== null && 'token' in auth && typeof auth.token === 'string'
        ? auth.token
        : null;
    try {
      if (!token) throw new Error('missing token');
      const payload = await this.jwt.verifyAsync<AccessTokenPayload>(token, {
        algorithms: ['HS256'],
      });
      await client.join(`user:${payload.sub}`);
      for (const role of (payload.roles ?? []).filter(isRole)) {
        await client.join(`role:${role}`);
      }
    } catch {
      client.emit('unauthorized');
      client.disconnect(true);
    }
  }

  /** Relays a database event to the affected users and roles. */
  publish(event: RealtimeEvent): void {
    if (!this.server) return;
    const rooms = [
      ...event.userIds.map((id) => `user:${id}`),
      ...event.roles.map((r) => `role:${r}`),
    ];
    if (rooms.length === 0) return;
    this.server.to(rooms).emit(event.type, {
      changeRequestId: event.changeRequestId,
      status: event.status,
      ...(event.jobId && { jobId: event.jobId }),
    });
    if (event.type === 'cr.updated' && event.userIds.length > 0) {
      // Recipients of new notification rows refresh their bell.
      this.server.to(event.userIds.map((id) => `user:${id}`)).emit('notification', {});
    }
    this.logger.debug(`relayed ${event.type} to ${rooms.length} room(s)`);
  }
}
