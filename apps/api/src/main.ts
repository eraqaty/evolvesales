import path from 'node:path';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { config as loadEnv } from 'dotenv';
import { AppModule } from './app.module.js';
import { AppConfig } from './config/app-config.js';
import { configureApp } from './configure-app.js';

// Local development reads the repository-root .env; real environment variables win.
loadEnv({ path: path.resolve(import.meta.dirname, '../../../.env'), quiet: true });

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  app.enableShutdownHooks();
  const config = app.get(AppConfig);

  if (!config.isProduction) {
    const doc = new DocumentBuilder()
      .setTitle('EvolveSales API')
      .setVersion(config.env.APP_VERSION)
      .addBearerAuth()
      .build();
    SwaggerModule.setup('api/docs', app, () => SwaggerModule.createDocument(app, doc));
  }

  await app.listen(config.env.API_PORT);
  Logger.log(`API listening on http://localhost:${config.env.API_PORT}/api/v1`, 'Bootstrap');
}

await bootstrap();
