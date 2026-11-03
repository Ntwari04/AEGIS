import { Controller, Get, Inject, Module, ServiceUnavailableException } from '@nestjs/common';
import Redis from 'ioredis';
import { Public } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { APP_ENV, AppEnv } from '../config/env';

@Controller('health')
export class HealthController {
  private readonly redis: Redis;

  constructor(private readonly prisma: PrismaService, @Inject(APP_ENV) env: AppEnv) {
    this.redis = new Redis(env.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false });
    this.redis.on('error', () => undefined);
  }

  /** Public by design (Docker/Nginx health probes). Reveals only ok/not-ok, never versions or errors. */
  @Get()
  @Public()
  async check() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      if (this.redis.status !== 'ready') await this.redis.connect().catch(() => undefined);
      if ((await this.redis.ping()) !== 'PONG') throw new Error('redis');
      return { status: 'ok' };
    } catch {
      throw new ServiceUnavailableException('unhealthy');
    }
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
