import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '../auth/auth.types.js';

export interface AuthenticatedRequest extends Request {
  user?: AuthUser;
  correlationId?: string;
}

/** Who did something, from where — passed to services for audit records. */
export interface RequestContext {
  actorId: string | null;
  ip: string | null;
  userAgent: string | null;
  correlationId: string | null;
  /** Where the action came from; WEB when absent. */
  channel?: 'WEB' | 'WHATSAPP';
}

export const CORRELATION_HEADER = 'x-correlation-id';

/** Accepts a caller-supplied correlation id (if sane) or creates one; echoes it on the response. */
export function correlationIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header(CORRELATION_HEADER);
  const id = incoming && /^[A-Za-z0-9._-]{8,64}$/.test(incoming) ? incoming : randomUUID();
  (req as AuthenticatedRequest).correlationId = id;
  res.setHeader(CORRELATION_HEADER, id);
  next();
}

export function contextFromRequest(req: AuthenticatedRequest): RequestContext {
  return {
    actorId: req.user?.id ?? null,
    ip: req.ip ?? null,
    userAgent: req.header('user-agent')?.slice(0, 500) ?? null,
    correlationId: req.correlationId ?? null,
  };
}

export const ReqCtx = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): RequestContext =>
    contextFromRequest(ctx.switchToHttp().getRequest<AuthenticatedRequest>()),
);
