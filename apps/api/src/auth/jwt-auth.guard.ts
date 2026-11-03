import { Logger, CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC } from './decorators';
import { TokenVerifier } from './token-verifier.service';
import { UsersService } from '../users/users.service';
import { AuditService } from '../audit/audit.service';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: TokenVerifier,
    private readonly users: UsersService,
    private readonly audit: AuditService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers['authorization'];
    const match = header?.match(/^Bearer (.+)$/i);
    if (!match) throw new UnauthorizedException('Missing bearer token');

    let verified;
    try {
      verified = await this.verifier.verify(match[1]);
    } catch (err) {
      // Reason code only (e.g. ERR_JWT_EXPIRED, ERR_JWT_CLAIM_VALIDATION_FAILED); never the token.
      this.logger.warn(`token rejected: ${(err as { code?: string }).code ?? (err as Error).name}: ${(err as Error).message}`);
      // FR-IAM-6: failed authentication is an audited event. The token itself is never logged.
      await this.audit.record({ action: 'auth.token_rejected', result: 'DENIED', sourceIp: req.ip });
      throw new UnauthorizedException('Invalid or expired token');
    }

    const user = await this.users.upsertFromToken(verified);
    req.user = {
      id: user.id,
      keycloakId: verified.sub,
      username: verified.username,
      email: verified.email,
      roles: verified.roles,
    };
    return true;
  }
}
