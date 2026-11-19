import { Controller, Get } from '@nestjs/common';
import { APP_NAME } from '@evolvesales/shared';

export interface HealthStatus {
  status: 'ok';
  app: string;
  service: 'api';
  version: string;
  time: string;
}

@Controller('health')
export class HealthController {
  @Get()
  check(): HealthStatus {
    return {
      status: 'ok',
      app: APP_NAME,
      service: 'api',
      version: process.env.APP_VERSION ?? 'dev',
      time: new Date().toISOString(),
    };
  }
}
