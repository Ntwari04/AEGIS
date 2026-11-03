import 'reflect-metadata';
import { ExecutionContext, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { Role } from '@aegisops/shared-types';
import { RolesGuard } from './roles.guard';
import { IS_PUBLIC, PROJECT_ACCESS, Public, ROLES_KEY, Roles, ProjectAccess } from './decorators';
import { ProjectAccessGuard, ProjectAccessService } from '../projects/project-access';
import { ProjectsController } from '../projects/projects.controller';
import { AuditController } from '../audit/audit.controller';
import { UsersController } from '../users/users.service';
import { DeploymentsController, WebhooksController } from '../deployments/deployments.controller';
import { HealthController } from '../health/health.controller';
import { sanitizeMetadata } from '../audit/audit.service';
import { loadEnv } from '../config/env';

const PID = '11111111-1111-4111-8111-111111111111';

function ctxFor(handler: Function, cls: Function, req: any): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => cls,
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function makeReq(roles: Role[], params: any = {}) {
  return { method: 'POST', url: '/x', ip: '1.2.3.4', params, user: { id: 'u1', username: 'alice', roles } };
}

describe('RolesGuard (default-deny)', () => {
  const audit = { record: jest.fn() };
  const guard = new RolesGuard(new Reflector(), audit as any);
  beforeEach(() => audit.record.mockClear());

  class C {
    @Roles('devops_engineer') allowed() {}
    @Public() open() {}
    undeclared() {}
    @Roles() emptyRoles() {}
  }

  it('allows a caller holding a declared role', async () => {
    await expect(guard.canActivate(ctxFor(C.prototype.allowed, C, makeReq(['devops_engineer'])))).resolves.toBe(true);
  });

  it('denies and audits a caller without the role', async () => {
    await expect(guard.canActivate(ctxFor(C.prototype.allowed, C, makeReq(['developer'])))).rejects.toThrow(ForbiddenException);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'authz.role_denied', result: 'DENIED' }));
  });

  it('denies an auditor on a mutating route', async () => {
    await expect(guard.canActivate(ctxFor(C.prototype.allowed, C, makeReq(['auditor'])))).rejects.toThrow(ForbiddenException);
  });

  it('allows @Public routes without a user', async () => {
    await expect(guard.canActivate(ctxFor(C.prototype.open, C, { ...makeReq([]), user: undefined }))).resolves.toBe(true);
  });

  it('fails CLOSED when a route declares neither @Public nor @Roles', async () => {
    await expect(guard.canActivate(ctxFor(C.prototype.undeclared, C, makeReq(['platform_admin'])))).rejects.toThrow(ForbiddenException);
  });

  it('fails closed on @Roles() with an empty list', async () => {
    await expect(guard.canActivate(ctxFor(C.prototype.emptyRoles, C, makeReq(['platform_admin'])))).rejects.toThrow(ForbiddenException);
  });

  it('denies when there is no authenticated user', async () => {
    await expect(guard.canActivate(ctxFor(C.prototype.allowed, C, { ...makeReq([]), user: undefined }))).rejects.toThrow(ForbiddenException);
  });

  it('ignores roles outside the known set (token claims are filtered upstream)', async () => {
    await expect(guard.canActivate(ctxFor(C.prototype.allowed, C, makeReq(['superuser' as Role])))).rejects.toThrow(ForbiddenException);
  });
});

describe('ProjectAccessService.levelFor', () => {
  const prisma = { projectMember: { findUnique: jest.fn() } };
  const svc = new ProjectAccessService(prisma as any);
  const user = (roles: Role[]) => ({ id: 'u1', keycloakId: 'k', username: 'a', roles });
  beforeEach(() => prisma.projectMember.findUnique.mockReset());

  it('platform_admin manages everything without a membership lookup', async () => {
    expect(await svc.levelFor(user(['platform_admin']), PID)).toBe('manage');
    expect(prisma.projectMember.findUnique).not.toHaveBeenCalled();
  });
  it('auditor reads everything but never manages', async () => {
    expect(await svc.levelFor(user(['auditor']), PID)).toBe('read');
  });
  it('developer who is not a member gets nothing', async () => {
    prisma.projectMember.findUnique.mockResolvedValue(null);
    expect(await svc.levelFor(user(['developer']), PID)).toBeNull();
  });
  it('developer member can read but never manage, even as OWNER', async () => {
    prisma.projectMember.findUnique.mockResolvedValue({ role: 'OWNER' });
    expect(await svc.levelFor(user(['developer']), PID)).toBe('read');
  });
  it('devops_engineer who owns the project manages it', async () => {
    prisma.projectMember.findUnique.mockResolvedValue({ role: 'OWNER' });
    expect(await svc.levelFor(user(['devops_engineer']), PID)).toBe('manage');
  });
  it('devops_engineer who is only a MEMBER reads but cannot manage', async () => {
    prisma.projectMember.findUnique.mockResolvedValue({ role: 'MEMBER' });
    expect(await svc.levelFor(user(['devops_engineer']), PID)).toBe('read');
  });
  it('non-UUID project ids never reach the database', async () => {
    expect(await svc.levelFor(user(['developer']), "x' OR 1=1 --")).toBeNull();
    expect(prisma.projectMember.findUnique).not.toHaveBeenCalled();
  });
  it('satisfies(): read does not grant manage', () => {
    expect(ProjectAccessService.satisfies('read', 'manage')).toBe(false);
    expect(ProjectAccessService.satisfies('manage', 'read')).toBe(true);
    expect(ProjectAccessService.satisfies(null, 'read')).toBe(false);
  });
});

describe('ProjectAccessGuard', () => {
  const audit = { record: jest.fn() };
  const access = { levelFor: jest.fn() };
  const guard = new ProjectAccessGuard(new Reflector(), access as any, audit as any);
  beforeEach(() => { audit.record.mockClear(); access.levelFor.mockReset(); });

  class C {
    @ProjectAccess('manage') manage() {}
    @ProjectAccess('read') read() {}
    undeclared() {}
    noProject() {}
    @Public() open() {}
  }

  it('non-member gets 404 (existence not disclosed) and a DENIED audit entry', async () => {
    access.levelFor.mockResolvedValue(null);
    await expect(guard.canActivate(ctxFor(C.prototype.read, C, makeReq(['developer'], { projectId: PID }))))
      .rejects.toThrow(NotFoundException);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'authz.project_denied', result: 'DENIED', targetId: PID }),
    );
  });
  it('read-level caller is denied a manage route', async () => {
    access.levelFor.mockResolvedValue('read');
    await expect(guard.canActivate(ctxFor(C.prototype.manage, C, makeReq(['auditor'], { projectId: PID }))))
      .rejects.toThrow(NotFoundException);
  });
  it('allows a caller with sufficient access', async () => {
    access.levelFor.mockResolvedValue('manage');
    await expect(guard.canActivate(ctxFor(C.prototype.manage, C, makeReq(['platform_admin'], { projectId: PID })))).resolves.toBe(true);
  });
  it('fails closed on a :projectId route with no @ProjectAccess declaration', async () => {
    await expect(guard.canActivate(ctxFor(C.prototype.undeclared, C, makeReq(['platform_admin'], { projectId: PID }))))
      .rejects.toThrow(NotFoundException);
    expect(access.levelFor).not.toHaveBeenCalled();
  });
  it('ignores routes with no project scope', async () => {
    await expect(guard.canActivate(ctxFor(C.prototype.noProject, C, makeReq(['developer'])))).resolves.toBe(true);
  });
});

describe('every controller route declares authorization (CI rule, PRD 8.2)', () => {
  const controllers = [ProjectsController, AuditController, UsersController, HealthController, DeploymentsController, WebhooksController];
  for (const ctrl of controllers) {
    const base: string = Reflect.getMetadata(PATH_METADATA, ctrl) ?? '';
    for (const name of Object.getOwnPropertyNames(ctrl.prototype).filter((n) => n !== 'constructor')) {
      const handler = (ctrl.prototype as any)[name];
      if (Reflect.getMetadata(METHOD_METADATA, handler) === undefined) continue;
      const route = `${ctrl.name}.${name}`;
      it(`${route} has @Roles or @Public`, () => {
        const pub = Reflect.getMetadata(IS_PUBLIC, handler);
        const roles = Reflect.getMetadata(ROLES_KEY, handler);
        expect(pub === true || (Array.isArray(roles) && roles.length > 0)).toBe(true);
      });
      const path: string = Reflect.getMetadata(PATH_METADATA, handler) ?? '';
      if (`${base}/${path}`.includes(':projectId')) {
        it(`${route} declares @ProjectAccess`, () => {
          expect(Reflect.getMetadata(PROJECT_ACCESS, handler)).toBeDefined();
        });
      }
    }
  }
  it('mutating project routes never allow the auditor role', () => {
    for (const name of Object.getOwnPropertyNames(ProjectsController.prototype)) {
      const handler = (ProjectsController.prototype as any)[name];
      const method = Reflect.getMetadata(METHOD_METADATA, handler);
      // RequestMethod: GET = 0; everything else mutates
      if (method === undefined || method === 0) continue;
      expect(Reflect.getMetadata(ROLES_KEY, handler)).not.toContain('auditor');
    }
  });
  it('auditors can never deploy or roll back', () => {
    for (const n of ['trigger', 'rollback']) {
      expect(Reflect.getMetadata(ROLES_KEY, (DeploymentsController.prototype as any)[n])).not.toContain('auditor');
    }
  });
  it('the audit log controller exposes only GET', () => {
    for (const name of Object.getOwnPropertyNames(AuditController.prototype)) {
      const method = Reflect.getMetadata(METHOD_METADATA, (AuditController.prototype as any)[name]);
      if (method !== undefined) expect(method).toBe(0);
    }
  });
});

describe('sanitizeMetadata', () => {
  it('redacts secret-shaped keys at any depth and keeps the rest', () => {
    const out = sanitizeMetadata({
      name: 'ok', password: 'p', nested: { apiKey: 'k', Authorization: 'Bearer x', keep: 1 },
      list: [{ client_secret: 's' }],
    });
    expect(out).toEqual({
      name: 'ok', password: '[redacted]',
      nested: { apiKey: '[redacted]', Authorization: '[redacted]', keep: 1 },
      list: [{ client_secret: '[redacted]' }],
    });
  });
});

describe('loadEnv', () => {
  const ok = {
    DATABASE_URL: 'x', REDIS_URL: 'x', WEB_ORIGIN: 'https://a.example', KEYCLOAK_ISSUER: 'x',
    KEYCLOAK_JWKS_URI: 'x', KEYCLOAK_AUDIENCE: 'x',
  };
  it('throws naming every missing variable', () => {
    expect(() => loadEnv({ ...ok, DATABASE_URL: '', REDIS_URL: undefined })).toThrow(/DATABASE_URL, REDIS_URL/);
  });
  it('refuses a wildcard CORS origin', () => {
    expect(() => loadEnv({ ...ok, WEB_ORIGIN: '*' })).toThrow(/explicit origin/);
  });
});
