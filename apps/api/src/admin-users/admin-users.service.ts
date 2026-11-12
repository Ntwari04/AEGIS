import { randomInt } from 'node:crypto';
import {
  BadGatewayException, ConflictException, HttpException, Injectable, NotFoundException, ServiceUnavailableException,
} from '@nestjs/common';
import type { Role } from '@aegisops/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { KeycloakAdmin, KeycloakAdminError, PLATFORM_ROLES } from './keycloak-admin';

export interface ManagedUser {
  id: string;
  username: string;
  email: string | null;
  enabled: boolean;
  roles: Role[];
  createdAt: string | null;
  lastSeenAt: string | null;
  /** True when this is the person asking: the screen hides the actions that would lock them out. */
  you: boolean;
}

/** 20 characters from an alphabet without look-alikes (no 0/O, 1/l/I). Temporary: Keycloak makes the person replace it at first sign-in. */
export function temporaryPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 20; i++) out += alphabet[randomInt(alphabet.length)];
  return out;
}

/** Turns a Keycloak failure into the HTTP error the screen shows. */
function http(e: unknown): never {
  if (e instanceof KeycloakAdminError) {
    if (e.status === 404) throw new NotFoundException(e.message);
    if (e.status === 409) throw new ConflictException(e.message);
    if (e.status === 503) throw new ServiceUnavailableException(e.message);
    throw new BadGatewayException(e.message);
  }
  if (e instanceof HttpException) throw e;
  throw e;
}

/**
 * The rules around user management (the Platform Admin persona). Keycloak stays the only place identities and roles live
 * (FR-IAM-1, FR-IAM-3); this decides what a platform admin may ask of it:
 *  - never change, disable or reset yourself (no way to lock the last door from the inside);
 *  - never leave the platform without an enabled platform admin;
 *  - a change that affects what someone may do ends their sessions at once (FR-IAM-7), both in Keycloak and in the API.
 */
@Injectable()
export class AdminUsersService {
  constructor(private readonly kc: KeycloakAdmin, private readonly prisma: PrismaService, private readonly users: UsersService) {}

  get configured() {
    return this.kc.configured;
  }

  async list(opts: { search?: string; first?: number; max?: number }, callerKeycloakId: string) {
    try {
      const [found, roles] = await Promise.all([this.kc.listUsers(opts), this.kc.rolesByUser()]);
      const seen = await this.prisma.user.findMany({ where: { keycloakId: { in: found.map((u) => u.id) } }, select: { keycloakId: true, lastSeenAt: true } });
      const lastSeen = new Map(seen.map((s) => [s.keycloakId, s.lastSeenAt]));
      return found.map((u): ManagedUser => ({
        id: u.id,
        username: u.username,
        email: u.email ?? null,
        enabled: u.enabled,
        roles: roles.get(u.id) ?? [],
        createdAt: u.createdTimestamp ? new Date(u.createdTimestamp).toISOString() : null,
        lastSeenAt: lastSeen.get(u.id)?.toISOString() ?? null,
        you: u.id === callerKeycloakId,
      }));
    } catch (e) { return http(e); }
  }

  async create(input: { username: string; email: string; role: Role }) {
    const password = temporaryPassword();
    try {
      const id = await this.kc.createUser({ username: input.username, email: input.email, temporaryPassword: password });
      try {
        await this.kc.setPlatformRole(id, input.role);
      } catch (e) {
        // A person with no role could sign in and see nothing; better to leave no half-made account behind.
        await this.kc.setEnabled(id, false).catch(() => undefined);
        throw e;
      }
      return { id, username: input.username, role: input.role, temporaryPassword: password };
    } catch (e) { return http(e); }
  }

  async changeRole(id: string, role: Role, callerKeycloakId: string) {
    if (id === callerKeycloakId) throw new ConflictException('You cannot change your own role. Ask another platform admin.');
    try {
      const target = await this.kc.getUser(id);
      const current = (await this.kc.rolesByUser()).get(id) ?? [];
      if (current.includes('platform_admin') && role !== 'platform_admin') await this.requireAnotherAdmin(id);
      await this.kc.setPlatformRole(id, role);
      await this.endSessions(id);
      return { id, username: target.username, role, previousRoles: current };
    } catch (e) { return http(e); }
  }

  async setEnabled(id: string, enabled: boolean, callerKeycloakId: string) {
    if (!enabled && id === callerKeycloakId) throw new ConflictException('You cannot disable your own account. Ask another platform admin.');
    try {
      const target = await this.kc.getUser(id);
      if (!enabled && ((await this.kc.rolesByUser()).get(id) ?? []).includes('platform_admin')) await this.requireAnotherAdmin(id);
      await this.kc.setEnabled(id, enabled);
      if (!enabled) await this.endSessions(id);
      return { id, username: target.username, enabled };
    } catch (e) { return http(e); }
  }

  async resetPassword(id: string, callerKeycloakId: string) {
    if (id === callerKeycloakId) throw new ConflictException('You cannot reset your own password here. Ask another platform admin.');
    const password = temporaryPassword();
    try {
      const target = await this.kc.getUser(id);
      await this.kc.setTemporaryPassword(id, password);
      await this.endSessions(id);
      return { id, username: target.username, temporaryPassword: password };
    } catch (e) { return http(e); }
  }

  async signOut(id: string) {
    try {
      const target = await this.kc.getUser(id);
      await this.endSessions(id);
      return { id, username: target.username };
    } catch (e) { return http(e); }
  }

  /** At least one OTHER enabled platform admin must remain. */
  private async requireAnotherAdmin(excluding: string) {
    const admins = (await this.kc.roleMembers('platform_admin')).filter((u) => u.enabled && u.id !== excluding);
    if (admins.length === 0) throw new ConflictException('That would leave the platform with no enabled platform admin.');
  }

  /** Keycloak sessions end now, and the API refuses every token this person already holds (FR-IAM-7). */
  private async endSessions(keycloakId: string) {
    await this.kc.logout(keycloakId).catch(() => undefined); // the API-side cut-off below is what protects; Keycloak's copy is best effort
    const local = await this.prisma.user.findUnique({ where: { keycloakId }, select: { id: true } });
    if (local) await this.users.revokeTokens(local.id);
  }
}

export { PLATFORM_ROLES };
