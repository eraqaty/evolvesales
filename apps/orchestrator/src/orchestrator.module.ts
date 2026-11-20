import { Module } from '@nestjs/common';
import { AnalysisAgent, NotConfiguredAnalysisAgent } from './analysis/analysis-agent.js';
import { AnalyzeHandler } from './analysis/analyze.handler.js';
import { OrchestratorConfig } from './config.js';
import { HealthController } from './health.controller.js';
import { PrismaService } from './prisma.service.js';
import { QueueWorkerService } from './queue-worker.service.js';

@Module({
  controllers: [HealthController],
  providers: [
    { provide: OrchestratorConfig, useFactory: () => OrchestratorConfig.fromEnvironment() },
    PrismaService,
    // Phase 3 swaps in the containerised Claude Agent SDK analysis agent.
    { provide: AnalysisAgent, useClass: NotConfiguredAnalysisAgent },
    AnalyzeHandler,
    QueueWorkerService,
  ],
})
export class OrchestratorModule {}
