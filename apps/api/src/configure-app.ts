import { type INestApplication, StandardSchemaValidationPipe } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import cookieParser from 'cookie-parser';
import type { ServerOptions } from 'socket.io';
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
  app.useWebSocketAdapter(new SocketAdapter(app, config.env.WEB_ORIGIN));
}

export const SOCKET_PATH = `/${API_PREFIX}/socket.io`;

/** Socket.IO under the API prefix, with the same CORS origin as REST. */
class SocketAdapter extends IoAdapter {
  constructor(
    app: INestApplication,
    private readonly origin: string,
  ) {
    super(app);
  }

  override createIOServer(
    port: number,
    options?: Parameters<IoAdapter['createIOServer']>[1],
  ): ReturnType<IoAdapter['createIOServer']> {
    return super.createIOServer(port, {
      ...(options as ServerOptions),
      path: SOCKET_PATH,
      cors: { origin: this.origin, credentials: true },
      maxHttpBufferSize: 16 * 1024,
    });
  }
}
