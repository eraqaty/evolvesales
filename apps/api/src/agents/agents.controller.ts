import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import {
  type AgentSettingsDto,
  type JobLogPageDto,
  type JobLogQuery,
  jobLogQuerySchema,
  type RepositoryDto,
  Role,
  type SetRepositoryAuthorizationInput,
  setRepositoryAuthorizationSchema,
  type UpdateAgentSettingsInput,
  updateAgentSettingsSchema,
} from '@evolvesales/shared';
import { z } from 'zod';
import type { AuthUser } from '../auth/auth.types.js';
import { CurrentUser, Roles } from '../auth/decorators.js';
import { type RequestContext, ReqCtx } from '../common/request-context.js';
import { AgentsService } from './agents.service.js';

const idParam = { schema: z.uuid() };

/** Admin-only agent configuration (§0, §11). */
@Controller('admin')
@Roles(Role.Admin)
export class AgentAdminController {
  constructor(private readonly agents: AgentsService) {}

  @Get('agent-settings')
  getSettings(): Promise<AgentSettingsDto> {
    return this.agents.getSettings();
  }

  @Put('agent-settings')
  updateSettings(
    @Body({ schema: updateAgentSettingsSchema }) body: UpdateAgentSettingsInput,
    @CurrentUser() user: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<AgentSettingsDto> {
    return this.agents.updateSettings(body, user, ctx);
  }

  @Get('repositories')
  listRepositories(): Promise<RepositoryDto[]> {
    return this.agents.listRepositories();
  }

  @Put('repositories/:id/authorization')
  setAuthorization(
    @Param('id', idParam) id: string,
    @Body({ schema: setRepositoryAuthorizationSchema }) body: SetRepositoryAuthorizationInput,
    @CurrentUser() user: AuthUser,
    @ReqCtx() ctx: RequestContext,
  ): Promise<RepositoryDto> {
    return this.agents.setAuthorization(id, body.authorized, user, ctx);
  }

  @Post('repositories/sync')
  @HttpCode(202)
  sync(@CurrentUser() user: AuthUser, @ReqCtx() ctx: RequestContext): Promise<{ queued: true }> {
    return this.agents.requestSync(user, ctx);
  }
}

/** Execution Monitor (§13): an agent job's log, visible to whoever may see the request. */
@Controller('change-requests/:id/jobs')
export class JobLogsController {
  constructor(private readonly agents: AgentsService) {}

  @Get(':jobId/logs')
  logs(
    @Param('id', idParam) id: string,
    @Param('jobId', idParam) jobId: string,
    @Query({ schema: jobLogQuerySchema }) q: JobLogQuery,
    @CurrentUser() user: AuthUser,
  ): Promise<JobLogPageDto> {
    return this.agents.jobLogs(id, jobId, q, user);
  }
}
