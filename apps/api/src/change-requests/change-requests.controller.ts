import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  type ApproveInput,
  approveSchema,
  type ChangeRequestDetailDto,
  type ChangeRequestSummaryDto,
  type ClarifyRequestInput,
  clarifyRequestSchema,
  type ListChangeRequestsQuery,
  listChangeRequestsQuerySchema,
  type Page,
  type RejectInput,
  rejectSchema,
  type RetryInput,
  retrySchema,
  Role,
} from '@evolvesales/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser, Roles } from '../auth/decorators.js';
import { ReqCtx, type RequestContext } from '../common/request-context.js';
import { ChangeRequestsService } from './change-requests.service.js';

const idParam = { schema: z.uuid() };

/**
 * Change requests (Screens C and D). Any signed-in user can list/read the requests they may
 * see (their own, or all for approvers/release managers/admins). Decisions need roles, and the
 * service re-checks lifecycle rules and separation of duties.
 */
@Controller('change-requests')
export class ChangeRequestsController {
  constructor(private readonly service: ChangeRequestsService) {}

  @Get()
  list(
    @Query({ schema: listChangeRequestsQuerySchema }) q: ListChangeRequestsQuery,
    @CurrentUser() user: AuthUser,
  ): Promise<Page<ChangeRequestSummaryDto>> {
    return this.service.list(q, user);
  }

  @Get(':id')
  get(
    @Param('id', idParam) id: string,
    @CurrentUser() user: AuthUser,
  ): Promise<ChangeRequestDetailDto> {
    return this.service.get(id, user);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @Roles(Role.ChangeApprover)
  approve(
    @Param('id', idParam) id: string,
    @Body({ schema: approveSchema }) body: ApproveInput,
    @CurrentUser() user: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<ChangeRequestDetailDto> {
    return this.service.approve(id, body, user, ctx);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @Roles(Role.ChangeApprover)
  reject(
    @Param('id', idParam) id: string,
    @Body({ schema: rejectSchema }) body: RejectInput,
    @CurrentUser() user: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<ChangeRequestDetailDto> {
    return this.service.reject(id, body, user, ctx);
  }

  @Post(':id/clarify')
  @HttpCode(200)
  @Roles(Role.ChangeApprover)
  clarify(
    @Param('id', idParam) id: string,
    @Body({ schema: clarifyRequestSchema }) body: ClarifyRequestInput,
    @CurrentUser() user: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<ChangeRequestDetailDto> {
    return this.service.clarify(id, body, user, ctx);
  }

  /** Admin only (RolesGuard lets ADMIN through every @Roles; ADMIN is the only role listed). */
  @Post(':id/retry')
  @HttpCode(200)
  @Roles(Role.Admin)
  retry(
    @Param('id', idParam) id: string,
    @Body({ schema: retrySchema }) body: RetryInput,
    @CurrentUser() user: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<ChangeRequestDetailDto> {
    return this.service.retry(id, body, user, ctx);
  }
}
