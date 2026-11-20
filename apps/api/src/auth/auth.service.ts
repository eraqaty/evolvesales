import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import argon2 from 'argon2';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { User } from '@evolvesales/db';
import { isRole } from '@evolvesales/shared';
import { AuditService } from '../audit/audit.service.js';
import type { RequestContext } from '../common/request-context.js';
import { AppConfig } from '../config/app-config.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AccessTokenPayload, AuthUser } from './auth.types.js';

export interface IssuedSession {
  accessToken: string;
  accessTokenExpiresIn: number;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  user: AuthUser;
}

const INVALID_CREDENTIALS = 'Invalid email or password';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  /** Verified against when the user doesn't exist, so response time doesn't reveal valid emails. */
  private readonly dummyHash: Promise<string>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {
    this.dummyHash = argon2.hash(randomBytes(16).toString('hex'), { type: argon2.argon2id });
  }

  async login(email: string, password: string, ctx: RequestContext): Promise<IssuedSession> {
    const normalized = email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email: normalized } });

    if (!user || !user.isActive) {
      await argon2.verify(await this.dummyHash, password).catch(() => false);
      await this.audit.record(
        {
          action: 'auth.login_failed',
          entityType: 'User',
          after: { email: normalized, reason: 'unknown_or_inactive' },
          actorId: null,
        },
        ctx,
      );
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) {
      await this.audit.record(
        { action: 'auth.login_locked', entityType: 'User', entityId: user.id, actorId: user.id },
        ctx,
      );
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    const valid = await argon2.verify(user.passwordHash, password).catch(() => false);
    if (!valid) {
      await this.registerFailure(user, ctx);
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    });
    const session = await this.issueSession(user, randomUUID(), ctx);
    await this.audit.record(
      { action: 'auth.login', entityType: 'User', entityId: user.id, actorId: user.id },
      ctx,
    );
    return session;
  }

  /** Rotates a refresh token. Reusing an already-rotated token revokes the whole family. */
  async refresh(rawToken: string | undefined, ctx: RequestContext): Promise<IssuedSession> {
    if (!rawToken) throw new UnauthorizedException('No session');
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(rawToken) },
      include: { user: true },
    });
    if (!stored) throw new UnauthorizedException('No session');

    if (stored.revokedAt) {
      await this.prisma.refreshToken.updateMany({
        where: { familyId: stored.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      this.logger.warn(`Refresh token reuse detected for user ${stored.userId}; family revoked`);
      await this.audit.record(
        {
          action: 'auth.refresh_reuse_detected',
          entityType: 'User',
          entityId: stored.userId,
          actorId: stored.userId,
        },
        ctx,
      );
      throw new UnauthorizedException('Session expired');
    }
    if (stored.expiresAt <= new Date() || !stored.user.isActive) {
      throw new UnauthorizedException('Session expired');
    }

    // Claim the token atomically so two concurrent refreshes can't both succeed.
    const claimed = await this.prisma.refreshToken.updateMany({
      where: { id: stored.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (claimed.count !== 1) throw new UnauthorizedException('Session expired');

    const session = await this.issueSession(stored.user, stored.familyId, ctx, stored.id);
    return session;
  }

  async logout(rawToken: string | undefined, ctx: RequestContext): Promise<void> {
    if (!rawToken) return;
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hashToken(rawToken) },
    });
    if (!stored) return;
    await this.prisma.refreshToken.updateMany({
      where: { familyId: stored.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.audit.record(
      {
        action: 'auth.logout',
        entityType: 'User',
        entityId: stored.userId,
        actorId: stored.userId,
      },
      ctx,
    );
  }

  async me(userId: string): Promise<AuthUser> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.isActive) throw new UnauthorizedException();
    return toAuthUser(user);
  }

  private async registerFailure(user: User, ctx: RequestContext): Promise<void> {
    const failures = user.failedLoginCount + 1;
    const lock = failures >= this.config.env.LOGIN_MAX_FAILURES;
    await this.prisma.user.update({
      where: { id: user.id },
      data: lock
        ? {
            failedLoginCount: 0,
            lockedUntil: new Date(Date.now() + this.config.env.LOGIN_LOCK_MINUTES * 60_000),
          }
        : { failedLoginCount: failures },
    });
    await this.audit.record(
      {
        action: lock ? 'auth.account_locked' : 'auth.login_failed',
        entityType: 'User',
        entityId: user.id,
        actorId: user.id,
        after: { failures },
      },
      ctx,
    );
  }

  private async issueSession(
    user: User,
    familyId: string,
    ctx: RequestContext,
    replacesId?: string,
  ): Promise<IssuedSession> {
    const authUser = toAuthUser(user);
    const payload: AccessTokenPayload = {
      sub: authUser.id,
      email: authUser.email,
      name: authUser.displayName,
      roles: authUser.roles,
    };
    const accessToken = await this.jwt.signAsync(payload);

    const refreshToken = randomBytes(32).toString('base64url');
    const refreshTokenExpiresAt = new Date(
      Date.now() + this.config.env.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
    );
    const created = await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        familyId,
        tokenHash: hashToken(refreshToken),
        expiresAt: refreshTokenExpiresAt,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      },
    });
    if (replacesId) {
      await this.prisma.refreshToken.update({
        where: { id: replacesId },
        data: { replacedById: created.id },
      });
    }

    return {
      accessToken,
      accessTokenExpiresIn: this.config.env.JWT_ACCESS_TTL_SECONDS,
      refreshToken,
      refreshTokenExpiresAt,
      user: authUser,
    };
  }
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function toAuthUser(user: User): AuthUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    roles: user.roles.filter(isRole),
  };
}
