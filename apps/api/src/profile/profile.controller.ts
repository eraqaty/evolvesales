import { Body, Controller, Delete, Get, HttpCode, Post, Put } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  type LinkPhoneInput,
  type LinkPhoneResult,
  linkPhoneSchema,
  type NotificationPrefs,
  notificationPrefsSchema,
  type SetApprovalPinInput,
  setApprovalPinSchema,
  type WhatsAppProfileDto,
} from '@evolvesales/shared';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators.js';
import { type RequestContext, ReqCtx } from '../common/request-context.js';
import { ProfileService } from './profile.service.js';

const profileLimit = () => Number(process.env.PROFILE_RATE_LIMIT_PER_MINUTE ?? 5);

/** The signed-in user's own WhatsApp settings. Every route acts on the caller only. */
@Controller('profile')
export class ProfileController {
  constructor(private readonly profile: ProfileService) {}

  @Get('whatsapp')
  get(@CurrentUser() user: AuthUser): Promise<WhatsAppProfileDto> {
    return this.profile.getWhatsApp(user);
  }

  @Throttle({ default: { limit: profileLimit, ttl: 60_000 } })
  @Post('whatsapp/link')
  startLink(
    @Body({ schema: linkPhoneSchema }) body: LinkPhoneInput,
    @CurrentUser() user: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<LinkPhoneResult> {
    return this.profile.startLink(body.phone, user, ctx);
  }

  @Delete('whatsapp')
  @HttpCode(204)
  unlink(@CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext): Promise<void> {
    return this.profile.unlink(user, ctx);
  }

  @Throttle({ default: { limit: profileLimit, ttl: 60_000 } })
  @Put('approval-pin')
  @HttpCode(204)
  setPin(
    @Body({ schema: setApprovalPinSchema }) body: SetApprovalPinInput,
    @CurrentUser() user: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<void> {
    return this.profile.setApprovalPin(body.pin, body.currentPassword, user, ctx);
  }

  @Put('notification-prefs')
  setPrefs(
    @Body({ schema: notificationPrefsSchema }) body: NotificationPrefs,
    @CurrentUser() user: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<NotificationPrefs> {
    return this.profile.setNotificationPrefs(body, user, ctx);
  }
}
