import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC, PROJECT_ACCESS, ProjectAccessLevel } from '../auth/decorators';
import type { AuthUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class ProjectAccessService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * FR-IAM-4 / PRD 6.1: Keycloak says who you are and your role; this decides which
   * projects you may touch.
   *  - platform_admin: read + manage everything
   *  - auditor:        read everything, manage nothing
   *  - devops_engineer: read if member; manage if project OWNER
   *  - developer:      read if member; never manage
   */
  async levelFor(user: AuthUser, projectId: string): Promise<ProjectAccessLevel | null> {
    if (user.roles.includes('platform_admin')) return 'manage';
    if (user.roles.includes('auditor')) return 'read';
    if (!UUID.test(projectId)) return null;
    const m = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId: user.id } },
    });
    if (!m) return null;
    if (m.role === 'OWNER' && user.roles.includes('devops_engineer')) return 'manage';
    return 'read';
  }

  static satisfies(have: ProjectAccessLevel | null, need: ProjectAccessLevel): boolean {
    if (!have) return false;
    return need === 'read' || have === 'manage';
  }
}

/**
 * Runs after RolesGuard. Fails closed: a route that takes :projectId but does not declare
 * @ProjectAccess(...) is rejected rather than served unchecked.
 * Non-members get 404, not 403, so project existence is not disclosed; the attempt is audited.
 */
@Injectable()
export class ProjectAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly access: ProjectAccessService,
    private readonly audit: AuditService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest();
    const need = this.reflector.getAllAndOverride<ProjectAccessLevel | undefined>(PROJECT_ACCESS, targets);
    const projectId: string | undefined = req.params?.projectId;

    if (!need && !projectId) return true;
    const user = req.user as AuthUser;
    const deny = async (reason: string) => {
      await this.audit.record({
        actorId: user?.id,
        actorName: user?.username,
        action: 'authz.project_denied',
        targetType: 'project',
        targetId: projectId,
        result: 'DENIED',
        sourceIp: req.ip,
        metadata: { reason, method: req.method },
      });
      throw new NotFoundException('Project not found');
    };

    if (!need) return deny('route_missing_project_access_declaration');
    const have = await this.access.levelFor(user, projectId as string);
    if (!ProjectAccessService.satisfies(have, need)) {
      return deny(have ? 'insufficient_project_access' : 'not_a_member');
    }
    return true;
  }
}
