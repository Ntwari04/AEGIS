import type { Role } from '@aegisops/shared-types';

/** The four roles AegisOps owns (FR-IAM-3). The admin client never reads or changes any other role mapping. */
export const PLATFORM_ROLES: Role[] = ['platform_admin', 'devops_engineer', 'developer', 'auditor'];

export interface KcUser {
  id: string;
  username: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  enabled: boolean;
  createdTimestamp?: number;
}

interface KcRole { id: string; name: string }

export class KeycloakAdminError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export interface KeycloakAdminConfig {
  /** Keycloak as the API reaches it inside the platform network, e.g. http://keycloak:8080 */
  baseUrl: string;
  realm: string;
  clientId: string;
  secret: string;
}

/**
 * The only door from AegisOps to Keycloak's admin API (PRD 6.1, the Platform Admin persona). It signs in as a dedicated service
 * account (`aegisops-admin`, client credentials, no browser flows) that holds realm-management's view/query/manage-users and
 * view-realm and nothing else. Every method here is a narrow operation the users screen needs; there is no general passthrough.
 * Passwords it sets are always temporary, so the person chooses their own at first sign-in.
 */
export class KeycloakAdmin {
  private cached?: { token: string; expiresAt: number };

  constructor(private readonly cfg: KeycloakAdminConfig | null, private readonly fetchImpl: typeof fetch = fetch, private readonly now: () => number = Date.now) {}

  get configured(): boolean {
    return this.cfg !== null;
  }

  private config(): KeycloakAdminConfig {
    if (!this.cfg) throw new KeycloakAdminError(503, 'User management is not set up on this server (the Keycloak admin client is not configured)');
    return this.cfg;
  }

  private async token(force = false): Promise<string> {
    const c = this.config();
    if (!force && this.cached && this.cached.expiresAt > this.now() + 15_000) return this.cached.token;
    const res = await this.fetchImpl(`${c.baseUrl}/realms/${c.realm}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: c.clientId, client_secret: c.secret }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => { throw new KeycloakAdminError(502, 'Keycloak could not be reached'); });
    if (!res.ok) throw new KeycloakAdminError(502, 'Keycloak refused the admin client (check KEYCLOAK_ADMIN_CLIENT_SECRET)');
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.cached = { token: body.access_token, expiresAt: this.now() + body.expires_in * 1000 };
    return body.access_token;
  }

  private async call(method: string, path: string, body?: unknown, retried = false): Promise<Response> {
    const c = this.config();
    const res = await this.fetchImpl(`${c.baseUrl}/admin/realms/${c.realm}${path}`, {
      method,
      headers: { Authorization: `Bearer ${await this.token(retried)}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => { throw new KeycloakAdminError(502, 'Keycloak could not be reached'); });
    if (res.status === 401 && !retried) return this.call(method, path, body, true);
    return res;
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.call(method, path, body);
    if (!res.ok) throw await this.fail(res);
    return (await res.json()) as T;
  }

  private async fail(res: Response): Promise<KeycloakAdminError> {
    const text = await res.text().catch(() => '');
    let message = '';
    try { message = (JSON.parse(text) as { errorMessage?: string; error?: string }).errorMessage ?? ''; } catch { /* not JSON */ }
    if (res.status === 404) return new KeycloakAdminError(404, 'That user does not exist');
    if (res.status === 409) return new KeycloakAdminError(409, 'A person with that username or email already exists');
    if (res.status === 403) return new KeycloakAdminError(502, 'The Keycloak admin client lacks a permission it needs');
    return new KeycloakAdminError(502, message || `Keycloak answered ${res.status}`);
  }

  async listUsers(opts: { search?: string; first?: number; max?: number }): Promise<KcUser[]> {
    const q = new URLSearchParams({ first: String(opts.first ?? 0), max: String(opts.max ?? 25), briefRepresentation: 'true' });
    if (opts.search) q.set('search', opts.search);
    return this.json<KcUser[]>('GET', `/users?${q}`);
  }

  async getUser(id: string): Promise<KcUser> {
    return this.json<KcUser>('GET', `/users/${encodeURIComponent(id)}`);
  }

  /** Direct members of one platform role (the roles are assigned directly, never through groups). */
  async roleMembers(role: Role): Promise<KcUser[]> {
    return this.json<KcUser[]>('GET', `/roles/${role}/users?first=0&max=1000&briefRepresentation=true`);
  }

  /** The platform role each person holds. Anyone missing from the result holds none. */
  async rolesByUser(): Promise<Map<string, Role[]>> {
    const lists = await Promise.all(PLATFORM_ROLES.map(async (r) => [r, await this.roleMembers(r)] as const));
    const out = new Map<string, Role[]>();
    for (const [role, members] of lists) for (const m of members) out.set(m.id, [...(out.get(m.id) ?? []), role]);
    return out;
  }

  /** Creates the person with a TEMPORARY password and returns their id. */
  async createUser(u: { username: string; email: string; temporaryPassword: string }): Promise<string> {
    const res = await this.call('POST', '/users', { username: u.username, email: u.email, enabled: true, emailVerified: true });
    if (!res.ok) throw await this.fail(res);
    const id = res.headers.get('location')?.split('/').pop();
    if (!id) throw new KeycloakAdminError(502, 'Keycloak created the user but did not say where');
    await this.setTemporaryPassword(id, u.temporaryPassword);
    return id;
  }

  async setTemporaryPassword(id: string, password: string): Promise<void> {
    const res = await this.call('PUT', `/users/${encodeURIComponent(id)}/reset-password`, { type: 'password', value: password, temporary: true });
    if (!res.ok) throw await this.fail(res);
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const res = await this.call('PUT', `/users/${encodeURIComponent(id)}`, { enabled });
    if (!res.ok) throw await this.fail(res);
  }

  /** Ends every Keycloak session of the person, so their refresh tokens stop working. */
  async logout(id: string): Promise<void> {
    const res = await this.call('POST', `/users/${encodeURIComponent(id)}/logout`);
    if (!res.ok) throw await this.fail(res);
  }

  /** Makes `role` the person's only platform role. Any other realm role they hold (Keycloak's defaults) is left alone. */
  async setPlatformRole(id: string, role: Role): Promise<void> {
    const base = `/users/${encodeURIComponent(id)}/role-mappings/realm`;
    const [held, available] = await Promise.all([this.json<KcRole[]>('GET', base), this.json<KcRole[]>('GET', `${base}/available`)]);
    const byName = new Map([...held, ...available].map((r) => [r.name, r]));
    const target = byName.get(role);
    if (!target) throw new KeycloakAdminError(502, `The realm has no role named ${role}`);
    const drop = held.filter((r) => (PLATFORM_ROLES as string[]).includes(r.name) && r.name !== role);
    if (drop.length) {
      const res = await this.call('DELETE', base, drop);
      if (!res.ok) throw await this.fail(res);
    }
    if (!held.some((r) => r.name === role)) {
      const res = await this.call('POST', base, [target]);
      if (!res.ok) throw await this.fail(res);
    }
  }

  /** Whether the person has enrolled an authenticator app (so the screen can show who still has to). */
  async hasTotp(id: string): Promise<boolean> {
    const creds = await this.json<{ type: string }[]>('GET', `/users/${encodeURIComponent(id)}/credentials`);
    return creds.some((c) => c.type === 'otp');
  }
}
