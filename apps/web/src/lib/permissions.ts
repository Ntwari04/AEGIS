import 'server-only';
import { auth } from '@/auth';
import type { Role } from '@aegisops/shared-types';

/**
 * UI-only convenience: hides controls the signed-in user cannot use. It is NOT a security boundary,
 * the API re-checks role and project membership on every call (default-deny).
 */
export async function currentRoles(): Promise<Role[]> {
  const session = await auth();
  return (((session as any)?.roles as Role[] | undefined) ?? []);
}

export const isPrivileged = (roles: Role[]) => roles.includes('platform_admin') || roles.includes('devops_engineer');

/** Mirrors FR-DEPLOY-6: production needs devops_engineer / platform_admin; developers may deploy non-production. */
export const canDeploy = (roles: Role[], isProduction: boolean) =>
  (isPrivileged(roles) || roles.includes('developer')) && (!isProduction || isPrivileged(roles));

export const canManageEnvironments = (roles: Role[]) => isPrivileged(roles);
