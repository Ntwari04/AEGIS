/**
 * Integration tests: REAL Postgres (migrations applied) and REAL Keycloak (the production realm file),
 * no mocks for auth or data integrity (PRD 12). Needs Docker.
 */
import 'reflect-metadata';
import { execSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SignJWT } from 'jose';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createHmac, randomBytes } from 'node:crypto';

jest.setTimeout(240_000);

const CLIENT_SECRET = 'integration-test-client-secret';
const PASSWORD = 'Integration-Pw-12345';
const USERS = [
  { username: 'it-admin', role: 'platform_admin' },
  { username: 'it-devops', role: 'devops_engineer' },
  { username: 'it-dev-a', role: 'developer' },
  { username: 'it-dev-b', role: 'developer' },
  { username: 'it-auditor', role: 'auditor' },
];

let pg: StartedPostgreSqlContainer;
let kc: StartedTestContainer;
let kcUrl: string;
let app: NestExpressApplication;
let prisma: PrismaClient;
const tokens: Record<string, string> = {};
const enqueued: string[] = [];
const WH_SECRET = 'integration-webhook-secret';

function realmForTests() {
  const raw = readFileSync(join(__dirname, '../../../infra/keycloak/realm-aegisops.json'), 'utf8')
    .replace(/\$\{KEYCLOAK_CLIENT_SECRET\}/g, CLIENT_SECRET)
    .replace(/\$\{WEB_ORIGIN\}/g, 'http://localhost:13000');
  const realm = JSON.parse(raw);
  // Test-only differences: password grant so we can mint real tokens without a browser, plus seeded users.
  realm.clients[0].directAccessGrantsEnabled = true;
  realm.users = USERS.map((u) => ({
    username: u.username, email: `${u.username}@example.test`, firstName: 'It', lastName: u.username,
    enabled: true, emailVerified: true,
    credentials: [{ type: 'password', value: PASSWORD, temporary: false }],
    realmRoles: [u.role],
  }));
  return JSON.stringify(realm);
}

async function login(username: string): Promise<string> {
  const res = await fetch(`${kcUrl}/realms/aegisops/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password', client_id: 'aegisops-web', client_secret: CLIENT_SECRET, username, password: PASSWORD,
    }),
  });
  if (!res.ok) throw new Error(`login ${username}: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

const as = (u: string) => ({ Authorization: `Bearer ${tokens[u]}` });
const http = () => request(app.getHttpServer());
const auditActions = async (where: object = {}) =>
  (await prisma.auditLogEntry.findMany({ where, orderBy: { createdAt: 'asc' } })).map((a) => `${a.action}:${a.result}`);

beforeAll(async () => {
  [pg, kc] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine').withDatabase('aegisops').start(),
    new GenericContainer('quay.io/keycloak/keycloak:26.4')
      .withEnvironment({ KC_BOOTSTRAP_ADMIN_USERNAME: 'admin', KC_BOOTSTRAP_ADMIN_PASSWORD: 'admin-test-pw' })
      .withCopyContentToContainer([{ content: realmForTests(), target: '/opt/keycloak/data/import/realm.json' }])
      .withCommand(['start-dev', '--import-realm'])
      .withExposedPorts(8080)
      .withWaitStrategy(Wait.forHttp('/realms/aegisops', 8080).forStatusCode(200))
      .withStartupTimeout(180_000)
      .start(),
  ]);
  kcUrl = `http://${kc.getHost()}:${kc.getMappedPort(8080)}`;

  const databaseUrl = pg.getConnectionUri();
  execSync('npx prisma migrate deploy', { cwd: join(__dirname, '..'), env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'pipe' });

  Object.assign(process.env, {
    DATABASE_URL: databaseUrl,
    REDIS_URL: 'redis://127.0.0.1:1',
    WEB_ORIGIN: 'http://localhost:13000',
    KEYCLOAK_ISSUER: `${kcUrl}/realms/aegisops`,
    KEYCLOAK_JWKS_URI: `${kcUrl}/realms/aegisops/protocol/openid-connect/certs`,
    KEYCLOAK_AUDIENCE: 'aegisops-api',
    GITHUB_WEBHOOK_SECRET: WH_SECRET,
    SECRETS_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  });

  const { AppModule } = await import('../src/app.module');
  const { configureApp } = await import('../src/configure-app');
  const { DEPLOYMENT_QUEUE } = await import('../src/deployments/deployments.controller');
  const { GITHUB_APP } = await import('../src/github/github-app');
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    // The GitHub App is installed on every repository except acme/not-installed.
    .overrideProvider(GITHUB_APP).useValue({ repoAccessible: async (repo: string) => repo !== 'acme/not-installed' })
    .overrideProvider(DEPLOYMENT_QUEUE).useValue({ enqueue: async (id: string) => void enqueued.push(id) })
    .compile();
  app = mod.createNestApplication<NestExpressApplication>({ rawBody: true });
  configureApp(app, process.env.WEB_ORIGIN!);
  await app.init();
  prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

  for (const u of USERS) tokens[u.username] = await login(u.username);
  // Every user hits the API once so their Keycloak identity is mirrored (needed for membership by username).
  for (const u of USERS) await http().get('/api/v1/me').set(as(u.username)).expect(200);
});

afterAll(async () => {
  await app?.close();
  await prisma?.$disconnect();
  await Promise.all([pg?.stop(), kc?.stop()]);
});

describe('authentication against real Keycloak tokens', () => {
  it('rejects a request with no token', async () => {
    await http().get('/api/v1/projects').expect(401);
  });

  it('accepts a real token and reads roles from the realm role claim', async () => {
    const me = await http().get('/api/v1/me').set(as('it-devops')).expect(200);
    expect(me.body.roles).toEqual(['devops_engineer']); // mfa_required marker role is filtered out
  });

  it('rejects garbage and audits the rejection (FR-IAM-6)', async () => {
    await http().get('/api/v1/projects').set({ Authorization: 'Bearer not.a.jwt' }).expect(401);
    expect(await auditActions({ action: 'auth.token_rejected' })).toContain('auth.token_rejected:DENIED');
  });

  it('rejects a token with valid-looking claims signed by a different key (forged)', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const forged = await new SignJWT({ roles: ['platform_admin'], preferred_username: 'mallory' })
      .setProtectedHeader({ alg: 'RS256', kid: 'forged' })
      .setSubject('forged-subject').setIssuer(process.env.KEYCLOAK_ISSUER!).setAudience('aegisops-api')
      .setIssuedAt().setExpirationTime('10m').sign(privateKey);
    await http().get('/api/v1/audit-log').set({ Authorization: `Bearer ${forged}` }).expect(401);
  });

  it('rejects an unsigned (alg=none) token', async () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
      sub: 'x', iss: process.env.KEYCLOAK_ISSUER, aud: 'aegisops-api', roles: ['platform_admin'],
      exp: Math.floor(Date.now() / 1000) + 600,
    })}.`;
    await http().get('/api/v1/audit-log').set({ Authorization: `Bearer ${none}` }).expect(401);
  });

  it('rejects a forged token claiming a different audience', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const wrongAud = await new SignJWT({ roles: ['platform_admin'] })
      .setProtectedHeader({ alg: 'RS256' }).setSubject('s').setIssuer(process.env.KEYCLOAK_ISSUER!)
      .setAudience('account').setExpirationTime('10m').sign(privateKey);
    await http().get('/api/v1/me').set({ Authorization: `Bearer ${wrongAud}` }).expect(401);
  });
});

describe('role + project authorization with real data (PRD 8.2, 12)', () => {
  let projectId: string;

  it('a developer cannot create a project, and the denial is audited', async () => {
    await http().post('/api/v1/projects').set(as('it-dev-a')).send({ name: 'Nope', slug: 'nope' }).expect(403);
    expect(await auditActions({ action: 'authz.role_denied', actorName: 'it-dev-a' })).toContain('authz.role_denied:DENIED');
  });

  it('a devops engineer creates a project and becomes its OWNER', async () => {
    const res = await http().post('/api/v1/projects').set(as('it-devops'))
      .send({ name: 'Billing', slug: 'billing', githubRepo: 'example-org/billing' }).expect(201);
    projectId = res.body.id;
    const owner = await prisma.projectMember.findFirst({ where: { projectId }, include: { user: true } });
    expect(owner?.role).toBe('OWNER');
    expect(owner?.user.username).toBe('it-devops');
    expect(await auditActions({ action: 'project.create' })).toContain('project.create:SUCCESS');
  });

  it('rejects duplicate slugs with 409', async () => {
    await http().post('/api/v1/projects').set(as('it-devops')).send({ name: 'Billing 2', slug: 'billing' }).expect(409);
  });

  it('a developer who is NOT a member cannot see or touch it; attempts are audited (e2e step 7)', async () => {
    await http().get(`/api/v1/projects/${projectId}`).set(as('it-dev-b')).expect(404);
    await http().get(`/api/v1/projects/${projectId}/environments`).set(as('it-dev-b')).expect(404);
    await http().patch(`/api/v1/projects/${projectId}`).set(as('it-dev-b')).send({ name: 'pwned' }).expect(403); // role gate first
    await http().post(`/api/v1/projects/${projectId}/api-keys`).set(as('it-dev-b'))
      .send({ name: 'k', scopes: ['deployments:trigger'] }).expect(404);
    const list = await http().get('/api/v1/projects').set(as('it-dev-b')).expect(200);
    expect(list.body.items.map((p: any) => p.id)).not.toContain(projectId);
    const denied = await prisma.auditLogEntry.findMany({
      where: { action: 'authz.project_denied', actorName: 'it-dev-b', targetId: projectId },
    });
    expect(denied.length).toBeGreaterThanOrEqual(3);
    expect(await prisma.project.findUnique({ where: { id: projectId } })).toMatchObject({ name: 'Billing' });
  });

  it('SQL-injection-shaped and malformed project ids are plain 404s', async () => {
    await http().get(`/api/v1/projects/${encodeURIComponent("1' OR '1'='1")}`).set(as('it-devops')).expect(404);
    await http().get('/api/v1/projects/not-a-uuid').set(as('it-dev-a')).expect(404);
  });

  it('once added as a member a developer can read but not manage', async () => {
    await http().post(`/api/v1/projects/${projectId}/members`).set(as('it-devops'))
      .send({ username: 'it-dev-a' }).expect(201);
    await http().get(`/api/v1/projects/${projectId}`).set(as('it-dev-a')).expect(200);
    await http().post(`/api/v1/projects/${projectId}/environments`).set(as('it-dev-a'))
      .send({ name: 'staging' }).expect(403);
    await http().post(`/api/v1/projects/${projectId}/members`).set(as('it-dev-a'))
      .send({ username: 'it-dev-b' }).expect(403);
  });

  it('the owner can create environments; invalid input is rejected at the boundary', async () => {
    await http().post(`/api/v1/projects/${projectId}/environments`).set(as('it-devops'))
      .send({ name: 'production', isProduction: true, domain: 'billing.example.com' }).expect(201);
    await http().post(`/api/v1/projects/${projectId}/environments`).set(as('it-devops'))
      .send({ name: 'Bad Name!' }).expect(400);
    await http().post('/api/v1/projects').set(as('it-devops'))
      .send({ name: 'X', slug: 'ok-slug', isAdmin: true }).expect(400); // unknown property
    await http().post('/api/v1/projects').set(as('it-devops'))
      .send({ name: 'Valid Name', slug: 'UPPER_case' }).expect(400);
  });

  it('a devops engineer who is only a member of someone else\'s project cannot manage it', async () => {
    await http().post(`/api/v1/projects/${projectId}/members`).set(as('it-devops'))
      .send({ username: 'it-dev-b', role: 'MEMBER' }).expect(201);
    const other = await http().post('/api/v1/projects').set(as('it-admin')).send({ name: 'Admin Proj', slug: 'admin-proj' }).expect(201);
    await http().get(`/api/v1/projects/${other.body.id}`).set(as('it-devops')).expect(404);
  });

  it('API keys: plaintext shown once, only a hash is stored, never audited', async () => {
    const res = await http().post(`/api/v1/projects/${projectId}/api-keys`).set(as('it-dev-a'))
      .send({ name: 'ci', scopes: ['deployments:trigger'] }).expect(201);
    const plaintext: string = res.body.key;
    expect(plaintext).toMatch(/^aegis_/);

    const row = await prisma.apiKey.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.keyHash).toBe(createHash('sha256').update(plaintext).digest('hex'));
    expect(JSON.stringify(row)).not.toContain(plaintext);

    const list = await http().get(`/api/v1/projects/${projectId}/api-keys`).set(as('it-dev-a')).expect(200);
    expect(JSON.stringify(list.body)).not.toContain(plaintext);
    expect(JSON.stringify(list.body)).not.toContain(row.keyHash);

    const audit = JSON.stringify(await prisma.auditLogEntry.findMany());
    expect(audit).not.toContain(plaintext);
    expect(audit).not.toContain(tokens['it-dev-a']);

    // Only the owner of a key (or an admin) may revoke it.
    await http().delete(`/api/v1/projects/${projectId}/api-keys/${res.body.id}`).set(as('it-dev-b')).expect(403);
    await http().delete(`/api/v1/projects/${projectId}/api-keys/${res.body.id}`).set(as('it-dev-a')).expect(204);
    expect((await prisma.apiKey.findUniqueOrThrow({ where: { id: res.body.id } })).revokedAt).not.toBeNull();
  });

  it('an unknown scope is rejected', async () => {
    await http().post(`/api/v1/projects/${projectId}/api-keys`).set(as('it-dev-a'))
      .send({ name: 'x', scopes: ['everything'] }).expect(400);
  });
});

describe('auditor is strictly read-only (e2e step 8)', () => {
  let projectId: string;
  beforeAll(async () => {
    projectId = (await prisma.project.findFirstOrThrow({ where: { slug: 'billing' } })).id;
  });

  it('can read all projects, a project, and the audit log', async () => {
    const list = await http().get('/api/v1/projects').set(as('it-auditor')).expect(200);
    expect(list.body.total).toBeGreaterThanOrEqual(2);
    await http().get(`/api/v1/projects/${projectId}`).set(as('it-auditor')).expect(200);
    const log = await http().get('/api/v1/audit-log?pageSize=200').set(as('it-auditor')).expect(200);
    expect(log.body.items.some((e: any) => e.action === 'authz.project_denied')).toBe(true);
  });

  it('cannot perform any mutating action', async () => {
    const a = as('it-auditor');
    await http().post('/api/v1/projects').set(a).send({ name: 'Aud', slug: 'aud' }).expect(403);
    await http().patch(`/api/v1/projects/${projectId}`).set(a).send({ name: 'x' }).expect(403);
    await http().delete(`/api/v1/projects/${projectId}`).set(a).expect(403);
    await http().post(`/api/v1/projects/${projectId}/members`).set(a).send({ username: 'it-dev-b' }).expect(403);
    await http().post(`/api/v1/projects/${projectId}/environments`).set(a).send({ name: 'x1' }).expect(403);
    await http().post(`/api/v1/projects/${projectId}/api-keys`).set(a).send({ name: 'k', scopes: ['deployments:read'] }).expect(403);
    expect(await prisma.project.count({ where: { slug: 'aud' } })).toBe(0);
  });

  it('developers and devops cannot read the audit log', async () => {
    await http().get('/api/v1/audit-log').set(as('it-dev-a')).expect(403);
    await http().get('/api/v1/audit-log').set(as('it-devops')).expect(403);
  });

  it('exposes no way to write the audit log through the API', async () => {
    for (const m of ['post', 'put', 'patch', 'delete'] as const) {
      const res = await (http() as any)[m]('/api/v1/audit-log').set(as('it-admin')).send({});
      expect([404, 405]).toContain(res.status);
    }
  });
});

describe('platform_admin', () => {
  it('can manage and delete any project, and the deletion is audited', async () => {
    const p = await http().post('/api/v1/projects').set(as('it-devops')).send({ name: 'Temp', slug: 'temp' }).expect(201);
    await http().delete(`/api/v1/projects/${p.body.id}`).set(as('it-admin')).expect(204);
    await http().delete(`/api/v1/projects/${p.body.id}`).set(as('it-devops')).expect(403);
    expect(await auditActions({ action: 'project.delete' })).toContain('project.delete:SUCCESS');
  });
});

describe('audit log is append-only in the database (FR-AUDIT-2)', () => {
  it('rejects UPDATE, DELETE and TRUNCATE even with full DB access', async () => {
    const row = await prisma.auditLogEntry.findFirstOrThrow();
    await expect(prisma.auditLogEntry.update({ where: { id: row.id }, data: { action: 'tampered' } })).rejects.toThrow(/append-only/);
    await expect(prisma.auditLogEntry.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/);
    await expect(prisma.auditLogEntry.deleteMany()).rejects.toThrow(/append-only/);
    await expect(prisma.$executeRawUnsafe('TRUNCATE "AuditLogEntry"')).rejects.toThrow(/append-only/);
    expect(await prisma.auditLogEntry.findUnique({ where: { id: row.id } })).toMatchObject({ action: row.action });
  });
});

describe('deployments: authorization, idempotency, webhook (PRD 6.4, FR-DEPLOY-1/4/6)', () => {
  const SHA = 'd'.repeat(40);
  let projectId: string;
  let stagingId: string;
  let prodId: string;
  const base = () => `/api/v1/projects/${projectId}/environments`;

  beforeAll(async () => {
    const p = await http().post('/api/v1/projects').set(as('it-devops'))
      .send({ name: 'Deployable', slug: 'deployable', githubRepo: 'Acme/Deployable' }).expect(201);
    projectId = p.body.id;
    stagingId = (await http().post(base()).set(as('it-devops')).send({ name: 'staging', branch: 'develop', domain: 'staging.example.com' }).expect(201)).body.id;
    prodId = (await http().post(base()).set(as('it-devops')).send({ name: 'production', isProduction: true, branch: 'main', domain: 'app.example.com' }).expect(201)).body.id;
    await http().post(`/api/v1/projects/${projectId}/members`).set(as('it-devops')).send({ username: 'it-dev-a' }).expect(201);
  });

  const trigger = (user: string, envId: string, body: object = { commitSha: SHA }, headers: Record<string, string> = {}) =>
    http().post(`${base()}/${envId}/deployments`).set(as(user)).set(headers).send(body);

  it('a developer member can deploy to non-production, not to production (FR-DEPLOY-6)', async () => {
    const ok = await trigger('it-dev-a', stagingId).expect(201);
    expect(ok.body).toMatchObject({ status: 'PENDING', triggerSource: 'manual', imageRef: `ghcr.io/acme/deployable:${SHA}` });
    expect(enqueued).toContain(ok.body.id);
    await trigger('it-dev-a', prodId).expect(403);
  });

  it('devops can deploy to production', async () => {
    await trigger('it-devops', prodId).expect(201);
  });

  it('a non-member developer gets 404 and the attempt is audited; the auditor gets 403', async () => {
    await trigger('it-dev-b', stagingId).expect(404);
    await trigger('it-auditor', stagingId).expect(403);
    expect(await auditActions({ action: 'authz.project_denied', actorName: 'it-dev-b', targetId: projectId })).toContain('authz.project_denied:DENIED');
  });

  it('the Idempotency-Key header prevents a retried request from double-deploying', async () => {
    const a = await trigger('it-devops', stagingId, { commitSha: SHA }, { 'Idempotency-Key': 'retry-1' }).expect(201);
    const b = await trigger('it-devops', stagingId, { commitSha: SHA }, { 'Idempotency-Key': 'retry-1' }).expect(201);
    expect(b.body.id).toBe(a.body.id);
  });

  it('refuses images outside the environment repository and malformed shas', async () => {
    await trigger('it-devops', stagingId, { commitSha: SHA, imageRef: 'evil.io/miner:latest' }).expect(400);
    await trigger('it-devops', stagingId, { commitSha: 'main' }).expect(400);
    await trigger('it-devops', stagingId, { commitSha: SHA, imageRef: 'ghcr.io/acme/deployable:custom' }).expect(201);
  });

  it('rollback only accepts a SUCCESS deployment of the same environment, and is role-gated', async () => {
    const d = await prisma.deployment.create({ data: { environmentId: stagingId, imageRef: 'ghcr.io/acme/deployable:old', commitSha: SHA, status: 'SUCCESS' } });
    const failed = await prisma.deployment.create({ data: { environmentId: stagingId, imageRef: 'x', commitSha: SHA, status: 'FAILED' } });
    const prodOk = await prisma.deployment.create({ data: { environmentId: prodId, imageRef: 'ghcr.io/acme/deployable:p', commitSha: SHA, status: 'SUCCESS' } });
    const url = (id: string, env = stagingId) => `${base()}/${env}/deployments/${id}/rollback`;

    const rb = await http().post(url(d.id)).set(as('it-dev-a')).expect(201);
    expect(rb.body).toMatchObject({ triggerSource: 'rollback', restoredFromId: d.id, imageRef: 'ghcr.io/acme/deployable:old' });
    await http().post(url(failed.id)).set(as('it-devops')).expect(404);
    await http().post(url(prodOk.id)).set(as('it-devops')).expect(404); // a deployment of another environment
    await http().post(url(prodOk.id, prodId)).set(as('it-dev-a')).expect(403); // developer cannot roll back production
    await http().post(url(d.id)).set(as('it-auditor')).expect(403);
  });

  it('members and auditors can read deployment history; non-members cannot', async () => {
    const list = await http().get(`${base()}/${stagingId}/deployments`).set(as('it-dev-a')).expect(200);
    expect(list.body.length).toBeGreaterThan(0);
    expect(list.body[0]).not.toHaveProperty('logs'); // list is summary-only
    await http().get(`${base()}/${stagingId}/deployments`).set(as('it-auditor')).expect(200);
    await http().get(`${base()}/${stagingId}/deployments`).set(as('it-dev-b')).expect(404);
  });

  describe('GitHub webhook', () => {
    const payload = (over: object = {}) => ({
      action: 'completed', repository: { full_name: 'acme/deployable' },
      workflow_run: { name: 'Build image', conclusion: 'success', head_branch: 'develop', head_sha: 'e'.repeat(40), ...over },
    });
    const send = (body: object, opts: { secret?: string; event?: string; delivery?: string } = {}) => {
      const raw = JSON.stringify(body);
      const sig = `sha256=${createHmac('sha256', opts.secret ?? WH_SECRET).update(raw).digest('hex')}`;
      return http().post('/api/v1/webhooks/github').set('Content-Type', 'application/json')
        .set('X-Hub-Signature-256', sig).set('X-GitHub-Event', opts.event ?? 'workflow_run')
        .set('X-GitHub-Delivery', opts.delivery ?? `del-${Math.random()}`).send(raw);
    };

    it('rejects a missing or wrong signature, audits it, and creates nothing', async () => {
      const before = await prisma.deployment.count();
      await http().post('/api/v1/webhooks/github').set('X-GitHub-Event', 'workflow_run').send(payload()).expect(403);
      await send(payload(), { secret: 'wrong' }).expect(403);
      expect(await prisma.deployment.count()).toBe(before);
      expect(await auditActions({ action: 'webhook.rejected' })).toContain('webhook.rejected:DENIED');
    });

    it('a signed successful "Build image" run deploys to the environment tracking that branch', async () => {
      const res = await send(payload(), { delivery: 'delivery-1' }).expect(201);
      expect(res.body.deployments).toHaveLength(1);
      const d = await prisma.deployment.findUniqueOrThrow({ where: { id: res.body.deployments[0] } });
      expect(d).toMatchObject({ environmentId: stagingId, triggerSource: 'webhook', imageRef: `ghcr.io/acme/deployable:${'e'.repeat(40)}`, triggeredById: null });
      expect(enqueued).toContain(d.id);
    });

    it('replaying the same delivery cannot double-deploy', async () => {
      const before = await prisma.deployment.count();
      const res = await send(payload(), { delivery: 'delivery-1' }).expect(201);
      expect(res.body.deployments).toEqual([]);
      expect(await prisma.deployment.count()).toBe(before);
    });

    it('main-branch runs target production only; unknown branches and repos deploy nothing', async () => {
      const prod = await send(payload({ head_branch: 'main' })).expect(201);
      const d = await prisma.deployment.findUniqueOrThrow({ where: { id: prod.body.deployments[0] } });
      expect(d.environmentId).toBe(prodId);
      expect((await send(payload({ head_branch: 'feature/x' })).expect(201)).body.deployments).toEqual([]);
      const other = { ...payload(), repository: { full_name: 'someone/else' } };
      expect((await send(other).expect(201)).body).toEqual({ ignored: true });
    });

    it('ignores failed runs, other workflows, other events and ping', async () => {
      const n = await prisma.deployment.count();
      expect((await send(payload({ conclusion: 'failure' }))).body).toEqual({ ignored: true });
      expect((await send(payload({ name: 'lint' }))).body).toEqual({ ignored: true });
      expect((await send(payload(), { event: 'push' })).body).toEqual({ ignored: true });
      expect((await send({}, { event: 'ping' })).body).toEqual({ ok: true });
      expect(await prisma.deployment.count()).toBe(n);
    });

    it('rejects a malformed head_sha (it is used to build an image reference)', async () => {
      await send(payload({ head_sha: 'latest; rm -rf /' })).expect(400);
    });
  });
});

describe('environment secrets and repository linking (FR-PROJ-2/3, FR-SEC-5)', () => {
  const VALUE = `topsecret-${randomBytes(6).toString('hex')}`;
  let projectId: string;
  let stagingId: string;
  let prodId: string;
  const url = (envId: string, name = '') => `/api/v1/projects/${projectId}/environments/${envId}/secrets${name ? `/${name}` : ''}`;

  beforeAll(async () => {
    const p = await http().post('/api/v1/projects').set(as('it-devops')).send({ name: 'Secrets', slug: 'secrets-proj' }).expect(201);
    projectId = p.body.id;
    const base = `/api/v1/projects/${projectId}/environments`;
    stagingId = (await http().post(base).set(as('it-devops')).send({ name: 'staging' }).expect(201)).body.id;
    prodId = (await http().post(base).set(as('it-devops')).send({ name: 'production', isProduction: true }).expect(201)).body.id;
    await http().post(`/api/v1/projects/${projectId}/members`).set(as('it-devops')).send({ username: 'it-dev-a' }).expect(201);
  });

  it('a developer member can set a non-production secret; the value is never returned, stored or audited in plaintext', async () => {
    const set = await http().put(url(stagingId, 'API_TOKEN')).set(as('it-dev-a')).send({ value: VALUE }).expect(200);
    expect(Object.keys(set.body).sort()).toEqual(['name', 'updatedAt']);
    expect(JSON.stringify(set.body)).not.toContain(VALUE);

    const list = await http().get(url(stagingId)).set(as('it-dev-a')).expect(200);
    expect(list.body.configured).toBe(true);
    expect(list.body.items.map((i: any) => i.name)).toEqual(['API_TOKEN']);
    expect(JSON.stringify(list.body)).not.toContain(VALUE);

    const row = await prisma.environmentSecret.findFirstOrThrow({ where: { environmentId: stagingId } });
    expect(row.valueEnc).not.toContain(VALUE);
    expect(JSON.stringify(await prisma.auditLogEntry.findMany())).not.toContain(VALUE);
    expect(await auditActions({ action: 'secret.set', actorName: 'it-dev-a' })).toContain('secret.set:SUCCESS');

    // the project detail endpoint must not leak it either
    expect(JSON.stringify((await http().get(`/api/v1/projects/${projectId}`).set(as('it-dev-a')).expect(200)).body)).not.toContain(VALUE);
  });

  it('production secrets need devops_engineer or platform_admin (same rule as FR-DEPLOY-6)', async () => {
    await http().put(url(prodId, 'API_TOKEN')).set(as('it-dev-a')).send({ value: 'x' }).expect(403);
    await http().put(url(prodId, 'API_TOKEN')).set(as('it-devops')).send({ value: 'prod-value' }).expect(200);
    await http().delete(url(prodId, 'API_TOKEN')).set(as('it-dev-a')).expect(403);
  });

  it('the auditor can list names but cannot write; a non-member gets 404', async () => {
    await http().get(url(stagingId)).set(as('it-auditor')).expect(200);
    await http().put(url(stagingId, 'OTHER')).set(as('it-auditor')).send({ value: 'x' }).expect(403);
    await http().delete(url(stagingId, 'API_TOKEN')).set(as('it-auditor')).expect(403);
    await http().get(url(stagingId)).set(as('it-dev-b')).expect(404);
    await http().put(url(stagingId, 'OTHER')).set(as('it-dev-b')).send({ value: 'x' }).expect(404);
  });

  it('validates names and values, and refuses to shadow platform variables', async () => {
    await http().put(url(stagingId, 'lower_case')).set(as('it-devops')).send({ value: 'x' }).expect(400);
    await http().put(url(stagingId, 'PORT')).set(as('it-devops')).send({ value: '1' }).expect(400);
    await http().put(url(stagingId, 'AEGIS_COMMIT')).set(as('it-devops')).send({ value: '1' }).expect(400);
    await http().put(url(stagingId, 'EMPTY')).set(as('it-devops')).send({ value: '' }).expect(400);
    await http().put(url(stagingId, 'BIG')).set(as('it-devops')).send({ value: 'x'.repeat(8193) }).expect(400);
    await http().put(url(stagingId, 'X')).set(as('it-devops')).send({}).expect(400);
  });

  it('overwrites on repeat, deletes, and cascades with the environment', async () => {
    await http().put(url(stagingId, 'ROTATE_ME')).set(as('it-devops')).send({ value: 'one' }).expect(200);
    await http().put(url(stagingId, 'ROTATE_ME')).set(as('it-devops')).send({ value: 'two' }).expect(200);
    expect((await http().get(url(stagingId)).set(as('it-devops'))).body.items.filter((i: any) => i.name === 'ROTATE_ME')).toHaveLength(1);
    await http().delete(url(stagingId, 'ROTATE_ME')).set(as('it-devops')).expect(204);
    expect((await http().get(url(stagingId)).set(as('it-devops'))).body.items.map((i: any) => i.name)).toEqual(['API_TOKEN']);
    await prisma.environment.delete({ where: { id: stagingId } });
    expect(await prisma.environmentSecret.count({ where: { environmentId: stagingId } })).toBe(0);
  });

  it('a project can only be linked to a repository the GitHub App is installed on (FR-PROJ-2)', async () => {
    const bad = await http().post('/api/v1/projects').set(as('it-devops')).send({ name: 'NoApp', slug: 'no-app', githubRepo: 'acme/not-installed' }).expect(400);
    expect(bad.body.error.message).toMatch(/GitHub App is not installed/);
    await http().post('/api/v1/projects').set(as('it-devops')).send({ name: 'WithApp', slug: 'with-app', githubRepo: 'acme/installed' }).expect(201);
    const created = await http().post('/api/v1/projects').set(as('it-devops')).send({ name: 'Upd', slug: 'upd-app' }).expect(201);
    await http().patch(`/api/v1/projects/${created.body.id}`).set(as('it-devops')).send({ githubRepo: 'acme/not-installed' }).expect(400);
  });

  it('resource limits are validated and stored per environment (FR-PROJ-3)', async () => {
    const base = `/api/v1/projects/${projectId}/environments`;
    await http().post(base).set(as('it-devops')).send({ name: 'tiny', memoryLimitMb: 8 }).expect(400);
    await http().post(base).set(as('it-devops')).send({ name: 'greedy', cpuLimit: 1000 }).expect(400);
    const ok = await http().post(base).set(as('it-devops')).send({ name: 'limited', memoryLimitMb: 256, cpuLimit: 0.5 }).expect(201);
    expect(ok.body).toMatchObject({ memoryLimitMb: 256, cpuLimit: 0.5 });
  });
});

describe('API-key deployments for CI (FR-IAM-5)', () => {
  const SHA = 'e'.repeat(40);
  let projectId: string;
  let otherProjectId: string;
  let key = '';
  let keyId = '';
  const post = (apiKey: string | undefined, body: object = { environment: 'staging', commitSha: SHA }, headers: Record<string, string> = {}) => {
    const r = http().post('/api/v1/ci/deployments').set(headers);
    return (apiKey ? r.set('X-API-Key', apiKey) : r).send(body);
  };

  beforeAll(async () => {
    projectId = (await http().post('/api/v1/projects').set(as('it-devops')).send({ name: 'CI', slug: 'ci-proj', githubRepo: 'acme/ci-proj' }).expect(201)).body.id;
    otherProjectId = (await http().post('/api/v1/projects').set(as('it-devops')).send({ name: 'Other', slug: 'ci-other', githubRepo: 'acme/ci-other' }).expect(201)).body.id;
    for (const id of [projectId, otherProjectId]) {
      await http().post(`/api/v1/projects/${id}/environments`).set(as('it-devops')).send({ name: 'staging' }).expect(201);
    }
    await http().post(`/api/v1/projects/${otherProjectId}/environments`).set(as('it-devops')).send({ name: 'only-other' }).expect(201);
    await http().post(`/api/v1/projects/${projectId}/environments`).set(as('it-devops')).send({ name: 'production', isProduction: true }).expect(201);
    const k = await http().post(`/api/v1/projects/${projectId}/api-keys`).set(as('it-devops')).send({ name: 'ci', scopes: ['deployments:trigger'] }).expect(201);
    key = k.body.key;
    keyId = k.body.id;
  });

  it('a valid key triggers a non-production deployment of its own project, attributed to the key in the audit log', async () => {
    const res = await post(key).expect(201);
    expect(res.body).toMatchObject({ status: 'PENDING', commitSha: SHA, environment: 'staging' });
    expect(enqueued).toContain(res.body.id);
    const dep = await prisma.deployment.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(dep).toMatchObject({ triggerSource: 'api-key', imageRef: `ghcr.io/acme/ci-proj:${SHA}` });
    expect((await prisma.apiKey.findUniqueOrThrow({ where: { id: keyId } })).lastUsedAt).not.toBeNull();
    const audit = await prisma.auditLogEntry.findFirstOrThrow({ where: { action: 'deployment.trigger', targetId: res.body.id } });
    expect(audit.actorName).toMatch(/^apikey:aegis_/);
    expect(JSON.stringify(await prisma.auditLogEntry.findMany())).not.toContain(key);
  });

  it('rejects missing, malformed, unknown and revoked keys (401) and audits each without logging the key', async () => {
    await post(undefined).expect(401);
    await post('not-a-key').expect(401);
    await post(`aegis_${'x'.repeat(43)}`).expect(401);
    const doomed = (await http().post(`/api/v1/projects/${projectId}/api-keys`).set(as('it-devops')).send({ name: 'doomed', scopes: ['deployments:trigger'] }).expect(201)).body;
    await post(doomed.key).expect(201);
    await http().delete(`/api/v1/projects/${projectId}/api-keys/${doomed.id}`).set(as('it-devops')).expect(204);
    await post(doomed.key).expect(401);
    const reasons = (await prisma.auditLogEntry.findMany({ where: { action: 'apikey.rejected' } })).map((a) => (a.metadata as any)?.reason);
    expect(reasons).toEqual(expect.arrayContaining(['malformed', 'unknown', 'revoked']));
    expect(JSON.stringify(await prisma.auditLogEntry.findMany())).not.toContain(doomed.key);
  });

  it('needs the deployments:trigger scope', async () => {
    const readOnly = (await http().post(`/api/v1/projects/${projectId}/api-keys`).set(as('it-devops')).send({ name: 'ro', scopes: ['deployments:read'] }).expect(201)).body;
    await post(readOnly.key).expect(403);
  });

  it('can never deploy to production, and cannot reach another project environment', async () => {
    await post(key, { environment: 'production', commitSha: SHA }).expect(403);
    await post(key, { environment: 'only-other', commitSha: SHA }).expect(404); // exists, but in another project
    await post(key, { environment: 'nope', commitSha: SHA }).expect(404);
  });

  it('validates the body', async () => {
    await post(key, { environment: 'staging', commitSha: 'main' }).expect(400);
    await post(key, { environment: 'Staging; rm -rf', commitSha: SHA }).expect(400);
    await post(key, { environment: 'staging' }).expect(400);
  });

  it('is idempotent with an Idempotency-Key', async () => {
    const a = await post(key, undefined, { 'Idempotency-Key': 'ci-run-42' }).expect(201);
    const b = await post(key, undefined, { 'Idempotency-Key': 'ci-run-42' }).expect(201);
    expect(b.body.id).toBe(a.body.id);
  });

  it('an API key is useless anywhere else: it is not a bearer token and not accepted by user routes', async () => {
    await http().get('/api/v1/projects').set('Authorization', `Bearer ${key}`).expect(401);
    await http().get('/api/v1/projects').set('X-API-Key', key).expect(401);
    await http().put(`/api/v1/projects/${projectId}/environments/x/secrets/A`).set('X-API-Key', key).send({ value: 'v' }).expect(401);
  });
});
