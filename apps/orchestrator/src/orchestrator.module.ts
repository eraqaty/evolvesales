import { Module } from '@nestjs/common';
import Docker from 'dockerode';
import { DockerLauncher, dockerClient } from './agent/docker-launcher.js';
import { ReaperService } from './agent/reaper.service.js';
import { AnalysisAgent } from './analysis/analysis-agent.js';
import { AnalyzeHandler } from './analysis/analyze.handler.js';
import { ContainerAnalysisAgent } from './analysis/container-analysis-agent.js';
import { OrchestratorConfig } from './config.js';
import { GitHubAppService } from './github/github-app.service.js';
import { RepoSyncService } from './github/repo-sync.service.js';
import { HealthController } from './health.controller.js';
import { PrismaService } from './prisma.service.js';
import { QueueWorkerService } from './queue-worker.service.js';

@Module({
  controllers: [HealthController],
  providers: [
    { provide: OrchestratorConfig, useFactory: () => OrchestratorConfig.fromEnvironment() },
    PrismaService,
    {
      provide: Docker,
      inject: [OrchestratorConfig],
      useFactory: (config: OrchestratorConfig) => dockerClient(config.env.AGENT_DOCKER_HOST),
    },
    DockerLauncher,
    ReaperService,
    GitHubAppService,
    RepoSyncService,
    { provide: AnalysisAgent, useClass: ContainerAnalysisAgent },
    AnalyzeHandler,
    QueueWorkerService,
  ],
})
export class OrchestratorModule {}
