import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { REALTIME_CHANNEL, type RealtimeEvent } from '@evolvesales/shared';
import pg from 'pg';
import { AppConfig } from '../config/app-config.js';
import { RealtimeGateway } from './realtime.gateway.js';

/**
 * Listens on Postgres NOTIFY (sent by lifecycle transitions in the API *and* the Orchestrator,
 * delivered only after commit) and relays the events to Socket.IO rooms.
 */
@Injectable()
export class RealtimeListenerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeListenerService.name);
  private client: pg.Client | null = null;
  private stopped = false;
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly gateway: RealtimeGateway,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.connect();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    await this.client?.end().catch(() => undefined);
  }

  private async connect(): Promise<void> {
    const client = new pg.Client({ connectionString: this.config.env.DATABASE_URL });
    client.on('notification', (msg) => {
      if (msg.channel !== REALTIME_CHANNEL || !msg.payload) return;
      const event = parseEvent(msg.payload);
      if (event) this.gateway.publish(event);
    });
    client.on('error', (err) => {
      this.logger.warn(`realtime listener lost its connection: ${err.message}`);
      this.scheduleReconnect();
    });
    try {
      await client.connect();
      await client.query(`LISTEN ${REALTIME_CHANNEL}`);
      this.client = client;
    } catch (err) {
      this.logger.warn(
        `realtime listener could not connect: ${err instanceof Error ? err.message : String(err)}`,
      );
      await client.end().catch(() => undefined);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retryTimer) return;
    this.client = null;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, 5_000);
  }
}

function parseEvent(payload: string): RealtimeEvent | null {
  try {
    const value: unknown = JSON.parse(payload);
    if (
      typeof value === 'object' &&
      value !== null &&
      'type' in value &&
      'userIds' in value &&
      'roles' in value &&
      Array.isArray(value.userIds) &&
      Array.isArray(value.roles)
    ) {
      return value as RealtimeEvent;
    }
  } catch {
    // ignore malformed payloads
  }
  return null;
}
