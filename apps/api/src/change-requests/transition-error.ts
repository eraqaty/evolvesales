import {
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { TransitionError } from '@evolvesales/db';

/** Maps lifecycle errors to HTTP: 404 / 409 (stale or invalid state) / 403 / 422. */
export function toHttpError(err: unknown): unknown {
  if (!(err instanceof TransitionError)) return err;
  const map: Record<TransitionError['code'], new (msg: string) => HttpException> = {
    not_found: NotFoundException,
    conflict: ConflictException,
    invalid_transition: ConflictException,
    actor_not_allowed: ForbiddenException,
    reason_required: UnprocessableEntityException,
  };
  return new map[err.code](err.message);
}

/** Runs `fn`, translating lifecycle errors into HTTP exceptions. */
export async function withHttpErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toHttpError(err);
  }
}
