import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_ENV, AppEnv, loadEnv } from './config/env';
import { PrismaModule } from './prisma/prisma.service';
import { AuditModule } from './audit/audit.controller';
import { AuditInterceptor } from './audit/audit.interceptor';
import { UsersModule } from './users/users.service';
import { TokenVerifier } from './auth/token-verifier.service';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RolesGuard } from './auth/roles.guard';
import { ProjectsModule } from './projects/projects.controller';
import { ProjectAccessGuard } from './projects/project-access';
import { DeploymentsModule } from './deployments/deployments.controller';
import { SecretsModule } from './secrets/secrets.controller';
import { MetricsModule } from './metrics/metrics.controller';
import { MonitoringModule } from './monitoring/monitoring.controller';
import { DataModule } from './backup/data.controller';
import { HealthModule } from './health/health.controller';
import { AllExceptionsFilter } from './common/http-exception.filter';

@Global()
@Module({
  providers: [{ provide: APP_ENV, useFactory: (): AppEnv => loadEnv() }, TokenVerifier],
  exports: [APP_ENV, TokenVerifier],
})
class CoreModule {}

@Module({
  imports: [
    // PRD 8.5: rate limiting on the whole API. The AegisOps API has no password endpoints (Keycloak owns login).
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    CoreModule,
    PrismaModule,
    AuditModule,
    UsersModule,
    ProjectsModule,
    DeploymentsModule,
    SecretsModule,
    MetricsModule,
    MonitoringModule,
    DataModule,
    HealthModule,
  ],
  providers: [
    // Order matters: throttle -> authenticate -> role check -> project membership check. Default-deny at each step.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useExisting: ProjectAccessGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
