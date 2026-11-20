import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Role } from '@evolvesales/shared';
import type { AuthenticatedRequest } from '../common/request-context.js';
import type { AuthUser } from './auth.types.js';

export const IS_PUBLIC = 'auth:isPublic';
export const REQUIRED_ROLES = 'auth:roles';

/** Opt a route out of authentication (login, refresh, health). Everything else requires a JWT. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Require at least one of the roles. ADMIN always passes. */
export const Roles = (...roles: Role[]) => SetMetadata(REQUIRED_ROLES, roles);

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const user = ctx.switchToHttp().getRequest<AuthenticatedRequest>().user;
    if (!user) throw new Error('CurrentUser used on a route without authentication');
    return user;
  },
);
