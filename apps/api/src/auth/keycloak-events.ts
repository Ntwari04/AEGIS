import { createHash } from 'node:crypto';

/**
 * Keycloak writes every event to its log as `key="value", key="value"` (the jboss-logging listener). Promtail ships that log to Loki,
 * and this module turns each line into an audit entry (FR-IAM-6) and, where it means a person's access changed, into a revocation
 * (FR-IAM-7). Pure functions only: no I/O, so every rule here is unit-tested.
 */
export interface ParsedEvent {
  /** Unique per log line, so reading the same line twice never writes it twice. */
  sourceKey: string;
  at: Date;
  action: string;
  result: 'SUCCESS' | 'DENIED' | 'ERROR';
  /** Username when Keycloak knows it, else the subject id. */
  actorName?: string;
  /** The Keycloak subject the event is about, when there is one. */
  subject?: string;
  sourceIp?: string;
  targetType: string;
  metadata: Record<string, unknown>;
  /** Tokens issued at or before `at` for this Keycloak subject must stop working. */
  revokes?: { subject: string; at: Date };
}

const PAIR = /(\w+)="((?:[^"\\]|\\.)*)"/g;
const unescape = (s: string) => s.replace(/\\(.)/g, '$1');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function pairsOf(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of line.matchAll(PAIR)) out[m[1]] = unescape(m[2]);
  return out;
}

/** Admin changes worth recording; everything else Keycloak does (for example token bookkeeping) is noise. */
const ADMIN_TYPES = new Set(['USER', 'REALM_ROLE_MAPPING', 'CLIENT_ROLE_MAPPING', 'GROUP_MEMBERSHIP', 'GROUP', 'REALM_ROLE', 'CLIENT', 'CLIENT_SCOPE_MAPPING', 'REALM']);
/** Admin changes that alter what ONE person may do, so their existing tokens are no longer trustworthy. */
const PERSON_CHANGES = new Set(['USER', 'REALM_ROLE_MAPPING', 'CLIENT_ROLE_MAPPING', 'GROUP_MEMBERSHIP']);

const userResult = (type: string): ParsedEvent['result'] =>
  type === 'LOGIN_ERROR' || type.startsWith('USER_DISABLED') ? 'DENIED' : type.endsWith('_ERROR') ? 'ERROR' : 'SUCCESS';

/**
 * `realm` is the application realm. Its events are recorded, and so are those of Keycloak's `master` realm: a sign-in there is someone
 * using the Keycloak admin console or `kcadm`, which is exactly what an auditor wants to see. Any other realm is not ours.
 * An ADMIN event carries the realm the admin signed in to (`master`), never the realm that was changed, so those are accepted as they are.
 */
export function parseKeycloakEvent(tsNs: string, line: string, realm: string): ParsedEvent | null {
  if (!line.includes('org.keycloak.events')) return null;
  const p = pairsOf(line);
  if (p.type && p.realmName !== realm && p.realmName !== 'master') return null;

  const ms = Number(BigInt(tsNs) / 1_000_000n);
  const at = new Date(ms);
  const sourceKey = `kc:${tsNs}:${createHash('sha1').update(line).digest('hex').slice(0, 10)}`;
  const known = (v?: string) => (v && v !== 'null' ? v : undefined);

  if (p.type) {
    // Routine token plumbing: every sign-in makes one of each, and a tool that stays signed in makes one per refresh. They say nothing the
    // sign-in itself does not, and they buried the events an auditor looks for. Their FAILURES (…_ERROR) are different and are kept.
    if (p.type === 'CODE_TO_TOKEN' || p.type === 'REFRESH_TOKEN') return null;
    const subject = known(p.userId);
    const metadata: Record<string, unknown> = {};
    if (p.realmName && p.realmName !== realm) metadata.realm = p.realmName;
    if (p.clientId) metadata.client = p.clientId;
    if (p.error) metadata.error = p.error;
    if (p.reason) metadata.reason = p.reason;
    if (p.auth_method) metadata.authMethod = p.auth_method;
    const ev: ParsedEvent = {
      sourceKey, at, action: `auth.${p.type.toLowerCase()}`, result: userResult(p.type),
      actorName: known(p.username) ?? subject, subject, sourceIp: known(p.ipAddress), targetType: 'user', metadata,
    };
    // Signing out, and an account switched off by a lockout, end that person's sessions: refuse the tokens already issued.
    if (subject && (p.type === 'LOGOUT' || p.type.startsWith('USER_DISABLED'))) ev.revokes = { subject, at };
    return ev;
  }

  if (p.operationType && p.resourceType) {
    if (!ADMIN_TYPES.has(p.resourceType)) return null;
    const path = known(p.resourcePath);
    const target = path?.match(/^users\/([^/]+)/)?.[1];
    const subject = target && UUID.test(target) ? target : undefined;
    const ev: ParsedEvent = {
      sourceKey, at, action: `auth.admin.${p.resourceType.toLowerCase()}.${p.operationType.toLowerCase()}`,
      result: p.error ? 'ERROR' : 'SUCCESS', actorName: 'keycloak-admin', subject, sourceIp: known(p.ipAddress),
      targetType: p.resourceType === 'USER' || subject ? 'user' : p.resourceType.toLowerCase(),
      metadata: { ...(path ? { resourcePath: path } : {}), ...(known(p.userId) ? { adminId: p.userId } : {}), ...(p.realmName ? { adminRealm: p.realmName } : {}) },
    };
    if (subject && PERSON_CHANGES.has(p.resourceType) && !p.error) ev.revokes = { subject, at };
    return ev;
  }
  return null;
}
