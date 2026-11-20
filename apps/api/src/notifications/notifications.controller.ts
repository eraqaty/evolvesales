import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators.js';
import { type NotificationList, NotificationsService } from './notifications.service.js';

/** The signed-in user's own notifications only. */
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser): Promise<NotificationList> {
    return this.service.list(user.id);
  }

  @Post('read-all')
  @HttpCode(204)
  markAllRead(@CurrentUser() user: AuthUser): Promise<void> {
    return this.service.markAllRead(user.id);
  }

  @Post(':id/read')
  @HttpCode(204)
  markRead(
    @Param('id', { schema: z.uuid() }) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    return this.service.markRead(id, user.id);
  }
}
