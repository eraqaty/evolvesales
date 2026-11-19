import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { OrchestratorModule } from './orchestrator.module.js';

/**
 * The orchestrator is a long-running worker. It exposes HTTP only for health checks;
 * job consumers (pg-boss) are registered in Phase 2.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(OrchestratorModule);
  app.enableShutdownHooks();

  const port = Number(process.env.ORCHESTRATOR_PORT ?? 3001);
  await app.listen(port);
  Logger.log(`Orchestrator health on http://localhost:${port}/health`, 'Bootstrap');
}

await bootstrap();
