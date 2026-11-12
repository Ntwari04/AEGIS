import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Role } from '@aegisops/shared-types';
import { AdminUsersService, temporaryPassword } from './admin-users.service';
import { KeycloakAdmin, KeycloakAdminError, type KcUser } from './keycloak-admin';

/** An in-memory Keycloak: people, their platform roles, and a record of every call that matters. */
function fakeKeycloak(people: { id: string; username: string; enabled?: boolean; roles: Role[] }[]) {
  const users = new Map(people.map((p) => [p.id, { ...p, enabled: p.enabled ?? true }]));
  const calls: string[] = [];
  const kc = {
    configured: true,
    listUsers: async () => [...users.values()].map((u): KcUser => ({ id: u.id, username: u.username, enabled: u.enabled })),
    getUser: async (id: string) => {
      const u = users.get(id);
      if (!u) throw new KeycloakAdminError(404, 'That user does not exist');
      return { id: u.id, username: u.username, enabled: u.enabled } as KcUser;
    },
    roleMembers: async (role: Role) => [...users.values()].filter((u) => u.roles.includes(role)).map((u) => ({ id: u.id, username: u.username, enabled: u.enabled })),
    rolesByUser: async () => new Map([...users.values()].map((u) => [u.id, u.roles] as const)),
    createUser: async (u: { username: string }) => {
      if ([...users.values()].some((x) => x.username === u.username)) throw new KeycloakAdminError(409, 'exists');
      const id = `new-${users.size}`;
      users.set(id, { id, username: u.username, enabled: true, roles: [] });
      calls.push(`create:${u.username}`);
      return id;
    },
    setTemporaryPassword: async (id: string) => void calls.push(`password:${id}`),
    setEnabled: async (id: string, enabled: boolean) => { users.get(id)!.enabled = enabled; calls.push(`enabled:${id}:${enabled}`); },
    logout: async (id: string) => void calls.push(`logout:${id}`),
    setPlatformRole: async (id: string, role: Role) => { users.get(id)!.roles = [role]; calls.push(`role:${id}:${role}`); },
  };
  return { kc: kc as unknown as KeycloakAdmin, users, calls, impl: kc };
}

function service(people: Parameters<typeof fakeKeycloak>[0]) {
  const fake = fakeKeycloak(people);
  const revoked: string[] = [];
  const prisma = { user: { findMany: async () => [], findUnique: async ({ where }: any) => ({ id: `local-${where.keycloakId}` }) } };
  const users = { revokeTokens: async (id: string) => void revoked.push(id) };
  return { svc: new AdminUsersService(fake.kc, prisma as any, users as any), revoked, ...fake };
}

const A = { id: 'admin-1', username: 'alice', roles: ['platform_admin'] as Role[] };
const B = { id: 'admin-2', username: 'bob', roles: ['platform_admin'] as Role[] };
const D = { id: 'dev-1', username: 'dana', roles: ['developer'] as Role[] };

describe('temporaryPassword', () => {
  it('is 20 characters with no look-alikes, and different every time', () => {
    const seen = new Set(Array.from({ length: 50 }, temporaryPassword));
    expect(seen.size).toBe(50);
    for (const p of seen) expect(p).toMatch(/^[A-HJ-NP-Za-km-z2-9]{20}$/);
  });
});

describe('AdminUsersService rules', () => {
  it('will not change, disable or reset the person asking', async () => {
    const { svc, calls } = service([A, B]);
    await expect(svc.changeRole('admin-1', 'developer', 'admin-1')).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.setEnabled('admin-1', false, 'admin-1')).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.resetPassword('admin-1', 'admin-1')).rejects.toBeInstanceOf(ConflictException);
    expect(calls).toEqual([]);
  });

  it('will not remove or disable the last enabled platform admin', async () => {
    const { svc, calls } = service([A, D]);
    await expect(svc.changeRole('admin-1', 'developer', 'dev-1')).rejects.toThrow(/no enabled platform admin/);
    await expect(svc.setEnabled('admin-1', false, 'dev-1')).rejects.toThrow(/no enabled platform admin/);
    expect(calls).toEqual([]);
  });

  it('does not count a disabled admin as one that remains', async () => {
    const { svc } = service([A, { ...B, enabled: false }]);
    await expect(svc.changeRole('admin-1', 'developer', 'someone-else')).rejects.toThrow(/no enabled platform admin/);
  });

  it('allows demoting an admin when another enabled one remains, and ends their sessions both places', async () => {
    const { svc, calls, revoked } = service([A, B, D]);
    const r = await svc.changeRole('admin-2', 'auditor', 'admin-1');
    expect(r).toMatchObject({ username: 'bob', role: 'auditor', previousRoles: ['platform_admin'] });
    expect(calls).toEqual(['role:admin-2:auditor', 'logout:admin-2']);
    expect(revoked).toEqual(['local-admin-2']);
  });

  it('disabling ends sessions; enabling does not need to', async () => {
    const { svc, calls, revoked } = service([A, D]);
    await svc.setEnabled('dev-1', false, 'admin-1');
    expect(calls).toEqual(['enabled:dev-1:false', 'logout:dev-1']);
    expect(revoked).toEqual(['local-dev-1']);
    await svc.setEnabled('dev-1', true, 'admin-1');
    expect(calls).toEqual(['enabled:dev-1:false', 'logout:dev-1', 'enabled:dev-1:true']);
  });

  it('a failed Keycloak logout never stops the API-side cut-off', async () => {
    const { svc, impl, revoked } = service([A, D]);
    impl.logout = async () => { throw new Error('keycloak is slow'); };
    await svc.signOut('dev-1');
    expect(revoked).toEqual(['local-dev-1']);
  });

  it('creating returns a temporary password once and leaves no role-less account behind if the role cannot be set', async () => {
    const ok = service([A]);
    const made = await ok.svc.create({ username: 'erin', email: 'e@example.test', role: 'devops_engineer' });
    expect(made).toMatchObject({ username: 'erin', role: 'devops_engineer' });
    expect(made.temporaryPassword).toHaveLength(20);

    const bad = service([A]);
    bad.impl.setPlatformRole = async () => { throw new KeycloakAdminError(502, 'no such role'); };
    await expect(bad.svc.create({ username: 'frank', email: 'f@example.test', role: 'auditor' })).rejects.toThrow('no such role');
    expect(bad.calls).toContain('enabled:new-1:false');
  });

  it('an unknown person is a 404 and a duplicate is a 409', async () => {
    const { svc } = service([A]);
    await expect(svc.signOut('nobody')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.create({ username: 'alice', email: 'a@example.test', role: 'auditor' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('says so plainly when Keycloak is not set up', async () => {
    const off = new AdminUsersService(new KeycloakAdmin(null), {} as any, {} as any);
    expect(off.configured).toBe(false);
    await expect(off.signOut('x')).rejects.toThrow(/not set up/);
  });
});
