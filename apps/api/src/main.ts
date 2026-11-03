import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './configure-app';
import { loadEnv } from './config/env';

async function bootstrap() {
  const env = loadEnv(); // fail fast before anything starts
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true }) // rawBody: webhook HMAC is computed over the exact bytes;
  configureApp(app, env.webOrigin);
  await app.listen(env.port, '0.0.0.0');
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
