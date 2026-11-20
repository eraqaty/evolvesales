import { type INestApplication, StandardSchemaValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { PrismaExceptionFilter } from './common/prisma-exception.filter.js';
import { correlationIdMiddleware } from './common/request-context.js';
import { AppConfig } from './config/app-config.js';

export const API_PREFIX = 'api/v1';

/** Shared by main.ts and the e2e tests so both run the same HTTP setup. */
export function configureApp(app: INestApplication): void {
  const config = app.get(AppConfig);

  app.setGlobalPrefix(API_PREFIX);
  app.use(helmet());
  app.use(cookieParser());
  app.use(correlationIdMiddleware);
  app.enableCors({ origin: config.env.WEB_ORIGIN, credentials: true });
  app.useGlobalPipes(new StandardSchemaValidationPipe());
  app.useGlobalFilters(new PrismaExceptionFilter());
}
