import { Controller, Get, Global, HttpCode, Injectable, Module, Post } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { VerifiedToken } from '../auth/token-verifier.service';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/auth.types';
import { Audited } from '../audit/audit.interceptor';
import { AuthEventsService } from '../auth/auth-events.service';

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

  /** FR-IAM-7: refuse every token issued to this person up to now. Never moves the cut-off backwards. */
  async revokeTokens(userId: string, at: Date = new Date()) {
    await this.prisma.user.updateMany({
      where: { id: userId, OR: [{ tokensValidAfter: null }, { tokensValidAfter: { lt: at } }] },
      data: { tokensValidAfter: at },
    });
  }
}

@Controller('me')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @Roles('platform_admin', 'devops_engineer', 'developer', 'auditor')
  me(@CurrentUser() user: AuthUser) {
    return { id: user.id, username: user.username, email: user.email ?? null, roles: user.roles };
  }

  /** Signing out ends the session on the server too: tokens already issued stop working at once, not when they expire. */
  @Post('revoke')
  @HttpCode(204)
  @Roles('platform_admin', 'devops_engineer', 'developer', 'auditor')
  @Audited({ action: 'auth.session_revoked', targetType: 'user' })
  async revoke(@CurrentUser() user: AuthUser) {
    await this.users.revokeTokens(user.id);
  }
}

@Global()
@Module({ providers: [UsersService, AuthEventsService], controllers: [UsersController], exports: [UsersService] })
export class UsersModule {}
