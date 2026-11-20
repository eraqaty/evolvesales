import { Module } from '@nestjs/common';
import { ChangeRequestsModule } from '../change-requests/change-requests.module.js';
import { AssistantController } from './assistant.controller.js';
import { AssistantService } from './assistant.service.js';
import { DataToolsService } from './data-tools.service.js';
import { LlmProvider } from './llm.provider.js';

@Module({
  imports: [ChangeRequestsModule],
  controllers: [AssistantController],
  providers: [AssistantService, DataToolsService, LlmProvider],
})
export class AssistantModule {}
