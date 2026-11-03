import { Controller, Get, Header, Injectable, MiddlewareConsumer, Module, NestMiddleware, NestModule } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { NextFunction, Request, Response } from 'express';
import { Public } from '../auth/decorators';
import { DeploymentsModule } from '../deployments/deployments.controller';
import { MetricsService } from './metrics.service';

/**
 * GET /metrics (FR-MON-1), Prometheus text format. It is excluded from the /api/v1 prefix and Nginx has no route for it,
 * so it is reachable only from inside aegisops-net (Prometheus); the public site returns 404 for /metrics.
 * It exposes counts and timings only, never request bodies, tokens or user data.
 */
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Public()
  @SkipThrottle()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  async scrape(): Promise<string> {
    return this.metrics.render();
  }
}

@Injectable()
export class RequestMetricsMiddleware implements NestMiddleware {
  constructor(private readonly metrics: MetricsService) {}

  use(req: Request, res: Response, next: NextFunction) {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      // The route PATTERN (e.g. /api/v1/projects/:projectId), or a constant for unmatched requests: bounded cardinality.
      const route = (req.route?.path as string | undefined) ?? 'unmatched';
      if (route === '/metrics') return;
      this.metrics.observe(req.method, route, res.statusCode, Number(process.hrtime.bigint() - start) / 1e9);
    });
    next();
  }
}

@Module({
  imports: [DeploymentsModule],
  controllers: [MetricsController],
  providers: [MetricsService, RequestMetricsMiddleware],
  exports: [MetricsService],
})
export class MetricsModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestMetricsMiddleware).forRoutes('*');
  }
}
