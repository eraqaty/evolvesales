import path from 'node:path';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { config as loadEnv } from 'dotenv';
import { OrchestratorConfig } from './config.js';
import { OrchestratorModule } from './orchestrator.module.js';

// Local development reads the repository-root .env; real environment variables win.
loadEnv({ path: path.resolve(import.meta.dirname, '../../../.env'), quiet: true });

/** Long-running worker: consumes pg-boss jobs; HTTP only for health checks. */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(OrchestratorModule);
  app.enableShutdownHooks();

  const port = app.get(OrchestratorConfig).env.ORCHESTRATOR_PORT;
  await app.listen(port);
  Logger.log(`Orchestrator health on http://localhost:${port}/health`, 'Bootstrap');
}

await bootstrap();
