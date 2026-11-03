import { Controller, Get, Global, Injectable, Module } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { VerifiedToken } from '../auth/token-verifier.service';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/auth.types';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  /** Mirrors the Keycloak subject on every authenticated request. Holds no credentials. */
  upsertFromToken(t: VerifiedToken) {
    return this.prisma.user.upsert({
      where: { keycloakId: t.sub },
      create: { keycloakId: t.sub, username: t.username, email: t.email },
      update: { username: t.username, email: t.email, lastSeenAt: new Date() },
    });
  }
}

@Controller('me')
export class UsersController {
  @Get()
  @Roles('platform_admin', 'devops_engineer', 'developer', 'auditor')
  me(@CurrentUser() user: AuthUser) {
    return { id: user.id, username: user.username, email: user.email ?? null, roles: user.roles };
  }
}

@Global()
@Module({ providers: [UsersService], controllers: [UsersController], exports: [UsersService] })
export class UsersModule {}
