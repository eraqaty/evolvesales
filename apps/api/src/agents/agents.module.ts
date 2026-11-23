import { Module } from '@nestjs/common';
import { AgentAdminController, JobLogsController } from './agents.controller.js';
import { AgentsService } from './agents.service.js';

@Module({
  controllers: [AgentAdminController, JobLogsController],
  providers: [AgentsService],
})
export class AgentsModule {}
