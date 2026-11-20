import type { Role } from '@evolvesales/shared';

/** The authenticated principal attached to each request by JwtAuthGuard. */
export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  roles: Role[];
}

export interface AccessTokenPayload {
  sub: string;
  email: string;
  name: string;
  roles: Role[];
}

export const REFRESH_COOKIE = 'es_refresh';
export const REFRESH_COOKIE_PATH = '/api/v1/auth';
