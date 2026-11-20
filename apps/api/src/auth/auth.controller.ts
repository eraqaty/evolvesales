import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { z } from 'zod';
import {
  type AuthenticatedRequest,
  ReqCtx,
  type RequestContext,
} from '../common/request-context.js';
import { AppConfig } from '../config/app-config.js';
import { AuthService, type IssuedSession } from './auth.service.js';
import { type AuthUser, REFRESH_COOKIE, REFRESH_COOKIE_PATH } from './auth.types.js';
import { CurrentUser, Public } from './decorators.js';

const loginSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(200),
});
type LoginBody = z.infer<typeof loginSchema>;

export interface SessionResponse {
  accessToken: string;
  expiresIn: number;
  user: AuthUser;
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: AppConfig,
  ) {}

  @Public()
  // Overrides the global limit for this route only: per client IP, per minute.
  @Throttle({
    default: { limit: () => Number(process.env.LOGIN_RATE_LIMIT_PER_MINUTE ?? 10), ttl: 60_000 },
  })
  @Post('login')
  @HttpCode(200)
  async login(
    @Body({ schema: loginSchema }) body: LoginBody,
    @ReqCtx() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionResponse> {
    const session = await this.auth.login(body.email, body.password, ctx);
    return this.respond(session, res);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() req: AuthenticatedRequest,
    @ReqCtx() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionResponse> {
    try {
      const session = await this.auth.refresh(readRefreshCookie(req), ctx);
      return this.respond(session, res);
    } catch (error) {
      this.clearCookie(res);
      throw error;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(
    @Req() req: AuthenticatedRequest,
    @ReqCtx() ctx: RequestContext,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.auth.logout(readRefreshCookie(req), ctx);
    this.clearCookie(res);
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser): Promise<AuthUser> {
    return this.auth.me(user.id);
  }

  private respond(session: IssuedSession, res: Response): SessionResponse {
    res.cookie(REFRESH_COOKIE, session.refreshToken, {
      httpOnly: true,
      secure: this.config.env.COOKIE_SECURE,
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
      expires: session.refreshTokenExpiresAt,
    });
    res.setHeader('Cache-Control', 'no-store');
    return {
      accessToken: session.accessToken,
      expiresIn: session.accessTokenExpiresIn,
      user: session.user,
    };
  }

  private clearCookie(res: Response): void {
    res.clearCookie(REFRESH_COOKIE, {
      httpOnly: true,
      secure: this.config.env.COOKIE_SECURE,
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
    });
  }
}

function readRefreshCookie(req: AuthenticatedRequest): string | undefined {
  const cookies = req.cookies as Record<string, string | undefined> | undefined;
  return cookies?.[REFRESH_COOKIE];
}
