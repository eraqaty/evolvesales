import { Controller, Get } from '@nestjs/common';
import { APP_NAME } from '@evolvesales/shared';

export interface OrchestratorHealth {
  status: 'ok';
  app: string;
  service: 'orchestrator';
  version: string;
  uptimeSeconds: number;
}

@Controller('health')
export class HealthController {
  @Get()
  check(): OrchestratorHealth {
    return {
      status: 'ok',
      app: APP_NAME,
      service: 'orchestrator',
      version: process.env.APP_VERSION ?? 'dev',
      uptimeSeconds: Math.round(process.uptime()),
    };
  }
}
