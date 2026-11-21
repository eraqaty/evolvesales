import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AssistantModule } from './assistant/assistant.module.js';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { ChangeRequestsModule } from './change-requests/change-requests.module.js';
import { ConfigModule } from './config/config.module.js';
import { HealthModule } from './health/health.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { ProfileModule } from './profile/profile.module.js';
import { QueueModule } from './queue/queue.module.js';
import { SalesModule } from './sales/sales.module.js';
import { WhatsAppModule } from './whatsapp/whatsapp.module.js';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    AuditModule,
    // Global per-IP limit; stricter limits are set per route (e.g. login).
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 600 }]),
    AuthModule,
    HealthModule,
    SalesModule,
    QueueModule,
    ChangeRequestsModule,
    AssistantModule,
    NotificationsModule,
    ProfileModule,
    WhatsAppModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
