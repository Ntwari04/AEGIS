import { SetMetadata, createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Role } from '@aegisops/shared-types';
import type { AuthUser } from './auth.types';

export const IS_PUBLIC = 'aegis:public';
export const ROLES_KEY = 'aegis:roles';
export const PROJECT_ACCESS = 'aegis:project-access';

/** Explicitly opts a route out of authentication. Everything else is default-deny. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** A route must declare which roles may call it. A route with no @Roles and no @Public is rejected. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

export type ProjectAccessLevel = 'read' | 'manage';
/** Requires the caller to hold the given access level on the project in `:projectId`. */
export const ProjectAccess = (level: ProjectAccessLevel) => SetMetadata(PROJECT_ACCESS, level);

export const CurrentUser = createParamDecorator((_d: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user;
});
