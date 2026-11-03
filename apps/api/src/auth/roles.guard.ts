import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@aegisops/shared-types';
import { IS_PUBLIC, ROLES_KEY } from './decorators';
import { AuditService } from '../audit/audit.service';

/**
 * Default-deny (PRD 8.2): a handler that declares neither @Public() nor @Roles(...)
 * is rejected, so a forgotten guard fails closed.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly audit: AuditService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const allowed = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, targets);
    const req = ctx.switchToHttp().getRequest();
    const user = req.user as { id: string; username: string; roles: Role[] } | undefined;

    const ok = !!user && !!allowed && allowed.length > 0 && user.roles.some((r) => allowed.includes(r));
    if (!ok) {
      await this.audit.record({
        actorId: user?.id,
        actorName: user?.username,
        action: 'authz.role_denied',
        targetType: 'route',
        targetId: `${req.method} ${req.route?.path ?? req.url}`,
        result: 'DENIED',
        sourceIp: req.ip,
      });
      throw new ForbiddenException('Insufficient role');
    }
    return true;
  }
}
