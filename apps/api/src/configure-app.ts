import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';

/** Shared by main.ts and the integration tests so tests exercise the real HTTP configuration. */
export function configureApp(app: NestExpressApplication, webOrigin: string) {
  app.set('trust proxy', 1); // behind Nginx: req.ip is the real client
  app.use(helmet());
  app.enableCors({ origin: [webOrigin], credentials: false });
  // /metrics (Prometheus) is intentionally outside the public /api/v1 tree; Nginx has no route for it.
  app.setGlobalPrefix('api/v1', { exclude: ['metrics'] });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
}
