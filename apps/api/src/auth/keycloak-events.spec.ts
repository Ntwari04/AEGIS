import { isRevoked } from './revocation';
import { pairsOf, parseKeycloakEvent } from './keycloak-events';

const SUB = '3ede34a2-cda5-4a5f-ae0d-d734ce568530';
const ADMIN = '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d';
const TS = '1793909023060396903'; // 2026-11-05T20:03:43.060Z
const ev = (line: string) => parseKeycloakEvent(TS, line, 'aegisops');

// Lines as Keycloak 26 writes them (copied from the live log, ids replaced).
const LOGIN_ERROR = `2026-11-05 20:03:43,059 WARN  [org.keycloak.events] (executor-thread-51) type="LOGIN_ERROR", realmId="r1", realmName="aegisops", clientId="aegisops-web", userId="${SUB}", ipAddress="172.22.0.1", error="invalid_user_credentials", auth_method="openid-connect", auth_type="code", redirect_uri="https://localtest.me/api/auth/callback/keycloak", code_id="c1", username="enock"`;
const LOGIN = `2026-11-08 18:48:30,106 INFO  [org.keycloak.events] (executor-thread-1) type="LOGIN", realmId="r1", realmName="aegisops", clientId="aegisops-web", userId="${SUB}", sessionId="s1", ipAddress="10.0.0.9", auth_method="openid-connect", token_id="t1", grant_type="authorization_code", scope="openid profile", username="anna"`;
const LOGOUT = `2026-11-08 18:50:00,000 INFO  [org.keycloak.events] (executor-thread-2) type="LOGOUT", realmId="r1", realmName="aegisops", clientId="aegisops-web", userId="${SUB}", ipAddress="10.0.0.9", username="anna"`;
const REFRESH_ERROR = `2026-11-05 20:05:14,244 WARN  [org.keycloak.events] (executor-thread-57) type="REFRESH_TOKEN_ERROR", realmId="r1", realmName="aegisops", clientId="aegisops-web", userId="null", ipAddress="172.22.0.1", error="invalid_token", reason="Token is not active", grant_type="refresh_token"`;
const ROLE_ADDED = `2026-11-08 18:48:34,379 INFO  [org.keycloak.events] (executor-thread-1) operationType="CREATE", realmId="m1", realmName="master", clientId="c9", userId="${ADMIN}", ipAddress="127.0.0.1", resourceType="REALM_ROLE_MAPPING", resourcePath="users/${SUB}/role-mappings/realm"`;
const USER_DELETED = `2026-11-08 18:48:38,036 INFO  [org.keycloak.events] (executor-thread-1) operationType="DELETE", realmId="m1", realmName="master", clientId="c9", userId="${ADMIN}", ipAddress="127.0.0.1", resourceType="USER", resourcePath="users/${SUB}"`;
const ADMIN_LOGIN = `2026-11-08 18:48:30,106 INFO  [org.keycloak.events] (executor-thread-1) type="LOGIN", realmId="m1", realmName="master", clientId="admin-cli", userId="${ADMIN}", ipAddress="127.0.0.1", grant_type="password", username="bootstrap-admin"`;

describe('pairsOf', () => {
  it('reads quoted key/value pairs, including escaped quotes', () => {
    expect(pairsOf('a="1", b="say \\"hi\\"", c="x"')).toEqual({ a: '1', b: 'say "hi"', c: 'x' });
  });
});

describe('parseKeycloakEvent: person events (FR-IAM-6)', () => {
  it('a failed login is a DENIED auth.login_error with the username, address and reason, and revokes nothing', () => {
    const e = ev(LOGIN_ERROR)!;
    expect(e).toMatchObject({ action: 'auth.login_error', result: 'DENIED', actorName: 'enock', subject: SUB, sourceIp: '172.22.0.1', targetType: 'user' });
    expect(e.metadata).toMatchObject({ client: 'aegisops-web', error: 'invalid_user_credentials', authMethod: 'openid-connect' });
    expect(e.revokes).toBeUndefined();
    expect(e.at.toISOString()).toBe('2026-11-05T20:03:43.060Z');
  });

  it('a successful login is SUCCESS and keeps nothing secret (no token ids, no scopes)', () => {
    const e = ev(LOGIN)!;
    expect(e).toMatchObject({ action: 'auth.login', result: 'SUCCESS', actorName: 'anna' });
    expect(JSON.stringify(e.metadata)).not.toMatch(/token|scope|session/i);
  });

  it('an unknown person ("null") has no subject and is named by what we do know', () => {
    const e = ev(REFRESH_ERROR)!;
    expect(e).toMatchObject({ action: 'auth.refresh_token_error', result: 'ERROR', subject: undefined, actorName: undefined });
    expect(e.metadata).toMatchObject({ reason: 'Token is not active' });
  });

  it('the master realm is recorded and labelled; any other realm is ignored', () => {
    expect(ev(ADMIN_LOGIN)).toMatchObject({ action: 'auth.login', actorName: 'bootstrap-admin', metadata: { realm: 'master', client: 'admin-cli' } });
    expect(ev(LOGIN.replace('realmName="aegisops"', 'realmName="someone-elses"'))).toBeNull();
  });

  it('drops routine token exchanges, which only add noise, but keeps their failures', () => {
    expect(ev(LOGIN.replace('type="LOGIN"', 'type="CODE_TO_TOKEN"'))).toBeNull();
    expect(ev(LOGIN.replace('type="LOGIN"', 'type="REFRESH_TOKEN"'))).toBeNull();
    expect(ev(REFRESH_ERROR)).not.toBeNull();
    expect(ev(LOGIN.replace('type="LOGIN"', 'type="CODE_TO_TOKEN_ERROR"'))).toMatchObject({ action: 'auth.code_to_token_error', result: 'ERROR' });
  });

  it('ignores lines that are not Keycloak events, and events with neither a type nor an operation', () => {
    expect(ev('2026-11-08 INFO [org.keycloak.services] something else type="LOGIN"')).toBeNull();
    expect(ev('[org.keycloak.events] realmName="aegisops"')).toBeNull();
  });
});

describe('parseKeycloakEvent: revocation (FR-IAM-7)', () => {
  it('signing out revokes that person\'s earlier tokens, as of the moment of the event', () => {
    const e = ev(LOGOUT)!;
    expect(e.revokes).toEqual({ subject: SUB, at: e.at });
  });

  it('a lockout revokes too', () => {
    const e = ev(LOGIN_ERROR.replace('type="LOGIN_ERROR"', 'type="USER_DISABLED_BY_TEMPORARY_LOCKOUT"'))!;
    expect(e).toMatchObject({ result: 'DENIED' });
    expect(e.revokes?.subject).toBe(SUB);
  });

  it('a role change names who it changed, is attributed to the admin, and revokes the person it changed', () => {
    const e = ev(ROLE_ADDED)!;
    expect(e).toMatchObject({ action: 'auth.admin.realm_role_mapping.create', result: 'SUCCESS', actorName: 'keycloak-admin', subject: SUB, targetType: 'user' });
    expect(e.metadata).toMatchObject({ resourcePath: `users/${SUB}/role-mappings/realm`, adminId: ADMIN, adminRealm: 'master' });
    expect(e.revokes).toEqual({ subject: SUB, at: e.at });
  });

  it('deleting or changing an account revokes it; a plain sign-in and an unrelated admin change do not', () => {
    expect(ev(USER_DELETED)!.revokes?.subject).toBe(SUB);
    expect(ev(LOGIN)!.revokes).toBeUndefined();
    const client = ev(ROLE_ADDED.replace('REALM_ROLE_MAPPING', 'CLIENT').replace(`users/${SUB}/role-mappings/realm`, 'clients/abc'))!;
    expect(client.revokes).toBeUndefined();
    expect(client.subject).toBeUndefined();
  });

  it('an admin change that failed revokes nothing', () => {
    expect(ev(ROLE_ADDED.replace('resourceType=', 'error="not_allowed", resourceType='))!.revokes).toBeUndefined();
  });

  it('admin noise outside the security-relevant types is dropped', () => {
    expect(ev(ROLE_ADDED.replace('REALM_ROLE_MAPPING', 'AUTHORIZATION_RESOURCE'))).toBeNull();
  });
});

describe('parseKeycloakEvent: identity of a line', () => {
  it('the source key is stable for the same line and different for different lines or times', () => {
    expect(ev(LOGIN)!.sourceKey).toBe(ev(LOGIN)!.sourceKey);
    expect(ev(LOGIN)!.sourceKey).not.toBe(ev(LOGOUT)!.sourceKey);
    expect(parseKeycloakEvent('1793909023060396904', LOGIN, 'aegisops')!.sourceKey).not.toBe(ev(LOGIN)!.sourceKey);
  });
});

describe('isRevoked', () => {
  const cutoff = new Date('2026-11-08T12:00:30.500Z');
  const sec = Math.floor(cutoff.getTime() / 1000);
  it('refuses tokens issued before or in the same second as the cut-off, accepts later ones', () => {
    expect(isRevoked(cutoff, sec - 60)).toBe(true);
    expect(isRevoked(cutoff, sec)).toBe(true);
    expect(isRevoked(cutoff, sec + 1)).toBe(false);
  });
  it('never refuses anyone who has no cut-off, and refuses a token that cannot say when it was issued', () => {
    expect(isRevoked(null, 1)).toBe(false);
    expect(isRevoked(undefined, undefined)).toBe(false);
    expect(isRevoked(cutoff, undefined)).toBe(true);
  });
});
