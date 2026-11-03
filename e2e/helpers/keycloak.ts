import { randomBytes } from 'node:crypto';

const KC = process.env.E2E_KEYCLOAK_URL ?? 'http://localhost:18080';
const REALM = 'aegisops';

async function adminToken(): Promise<string> {
  const res = await fetch(`${KC}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: process.env.E2E_KC_ADMIN_USER!,
      password: process.env.E2E_KC_ADMIN_PASSWORD!,
    }),
  });
  if (!res.ok) throw new Error(`keycloak admin login failed: ${res.status}`);
  return (await res.json()).access_token;
}

/** Creates a throwaway test user in the LOCAL dev Keycloak with a temporary password (forces the real first-login flow). */
export async function createUser(role: string, opts: { temporary: boolean }) {
  const token = await adminToken();
  const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const username = `e2e-${role.replace('_', '')}-${randomBytes(3).toString('hex')}`;
  const password = `Pw-${randomBytes(9).toString('base64url')}-1a`;

  const created = await fetch(`${KC}/admin/realms/${REALM}/users`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      username, email: `${username}@example.test`, enabled: true, emailVerified: true,
      firstName: 'E2E', lastName: role,
      credentials: [{ type: 'password', value: password, temporary: opts.temporary }],
    }),
  });
  if (created.status !== 201) throw new Error(`create user failed: ${created.status} ${await created.text()}`);
  const id = created.headers.get('location')!.split('/').pop()!;

  const roleRep = await (await fetch(`${KC}/admin/realms/${REALM}/roles/${role}`, { headers: auth })).json();
  const mapped = await fetch(`${KC}/admin/realms/${REALM}/users/${id}/role-mappings/realm`, {
    method: 'POST', headers: auth, body: JSON.stringify([roleRep]),
  });
  if (mapped.status !== 204) throw new Error(`role mapping failed: ${mapped.status}`);
  return { id, username, password };
}
