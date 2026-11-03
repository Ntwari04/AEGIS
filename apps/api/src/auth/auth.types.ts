import type { Role } from '@aegisops/shared-types';

/** The authenticated caller, built from a Keycloak-validated JWT plus the mirrored User row. */
export interface AuthUser {
  /** AegisOps User.id */
  id: string;
  keycloakId: string;
  username: string;
  email?: string;
  roles: Role[];
}
