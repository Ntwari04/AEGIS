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
const monitoring = {
  available: true,
  up: 1,
  alerts: [{ name: 'HostMemoryHigh', severity: 'warning', summary: 'Host memory above 90%', since: new Date().toISOString() }] as any[],
};
const enqueued: string[] = [];
const dataJobs: { name: string; data: any }[] = [];
const containerJobs: any[] = [];
const logCalls: { project: string; environment: string; opts: any }[] = [];
const infraStub = { lokiDown: false };

/** A signed GitHub "Build image" workflow_run delivery. */
async function signedWorkflowRun(repo: string, sha: string, branch: string) {
  const raw = JSON.stringify({ action: 'completed', repository: { full_name: repo }, workflow_run: { name: 'Build image', conclusion: 'success', head_branch: branch, head_sha: sha } });
  const sig = `sha256=${createHmac('sha256', WH_SECRET).update(raw).digest('hex')}`;
  return http().post('/api/v1/webhooks/github').set('Content-Type', 'application/json')
    .set('X-Hub-Signature-256', sig).set('X-GitHub-Event', 'workflow_run').set('X-GitHub-Delivery', `del-${Math.random()}`).send(raw);
}
const WH_SECRET = 'integration-webhook-secret';

function realmForTests() {
  const raw = readFileSync(join(__dirname, '../../../infra/keycloak/realm-aegisops.json'), 'utf8')
    .replace(/\$\{KEYCLOAK_CLIENT_SECRET\}/g, CLIENT_SECRET)
    .replace(/\$\{WEB_ORIGIN\}/g, 'http://localhost:13000')
    .replace(/\$\{GRAFANA_OAUTH_SECRET\}/g, 'grafana-test-secret')
    .replace(/\$\{GRAFANA_ORIGIN\}/g, 'https://grafana.test.example');
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
    GRAFANA_PUBLIC_URL: 'https://grafana.test.example',
  });

  const { AppModule } = await import('../src/app.module');
  const { configureApp } = await import('../src/configure-app');
  const { DEPLOYMENT_QUEUE } = await import('../src/deployments/deployments.controller');
  const { GITHUB_APP } = await import('../src/github/github-app');
  const { MonitoringClient } = await import('../src/monitoring/monitoring.controller');
  const { DATA_JOB_QUEUE } = await import('../src/backup/data-jobs');
  const { CONTAINER_JOB_QUEUE } = await import('../src/infra/infra.controller');
  const mod = await Test.createTestingModule({ imports: [AppModule] })
    // The GitHub App is installed on every repository except acme/not-installed.
    .overrideProvider(GITHUB_APP).useValue({ repoAccessible: async (repo: string) => repo !== 'acme/not-installed' })
    .overrideProvider(MonitoringClient).useValue({
      get configured() { return true; },
      containerSamples: async () => {
        if (!monitoring.available) throw new Error('prometheus down');
        const m = (value: number) => [{ metric: { name: 'dash-a-live', project: 'dash-a', environment: 'staging' }, value }];
        return { up: m(monitoring.up), restarting: m(0), cpu: m(0.1), memory: m(1_000_000), memoryLimit: [], restarts1h: m(0), started: m(Date.now() / 1000 - 60) };
      },
      platformSummary: async () => ({ containersUp: 17, containersTotal: 17, hostMemoryUsed: 0.4, diskUsed: 0.5 }),
      query: async (expr: string) => (expr === 'aegisops_container_up' ? [{ metric: { name: 'aegisops-api', project: '', environment: '' }, value: 1 }] : []),
      logs: async (project: string, environment: string, opts: any) => {
        if (infraStub.lokiDown) throw new Error('loki is down');
        logCalls.push({ project, environment, opts });
        return [{ ts: new Date().toISOString(), line: 'listening on 3000', container: 'aegis-infra-proj-staging-1' }];
      },
      alerts: async () => monitoring.alerts,
    })
    .overrideProvider(CONTAINER_JOB_QUEUE).useValue({ enqueue: async (j: any) => void containerJobs.push(j) })
    .overrideProvider(DATA_JOB_QUEUE).useValue({ enqueue: async (j: { name: string; data: any }) => void dataJobs.push(j) })
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

    it('every project linked to the repository is deployed, not just the first one', async () => {
      const twin = await http().post('/api/v1/projects').set(as('it-devops'))
        .send({ name: 'Deployable twin', slug: 'deployable-twin', githubRepo: 'acme/DEPLOYABLE' }).expect(201);
      const twinEnv = (await http().post(`/api/v1/projects/${twin.body.id}/environments`).set(as('it-devops'))
        .send({ name: 'staging', branch: 'develop', domain: 'twin.example.com' }).expect(201)).body.id;
      try {
        const res = await send(payload({ head_sha: 'f'.repeat(40) })).expect(201);
        const hit = await prisma.deployment.findMany({ where: { id: { in: res.body.deployments } } });
        expect(hit.map((d) => d.environmentId).sort()).toEqual([stagingId, twinEnv].sort());
      } finally {
        await prisma.project.delete({ where: { id: twin.body.id } });
      }
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

describe('Prometheus metrics (FR-MON-1)', () => {
  let projectId: string;
  let envId: string;

  beforeAll(async () => {
    projectId = (await http().post('/api/v1/projects').set(as('it-devops')).send({ name: 'Metrics', slug: 'metrics-proj' }).expect(201)).body.id;
    envId = (await http().post(`/api/v1/projects/${projectId}/environments`).set(as('it-devops')).send({ name: 'staging' }).expect(201)).body.id;
    const now = new Date();
    // an older success, a newer success (the live one), and a failure
    await prisma.deployment.create({ data: { environmentId: envId, status: 'SUCCESS', containerName: 'old-container', commitSha: 'a'.repeat(40), finishedAt: new Date(now.getTime() - 60_000) } });
    await prisma.deployment.create({ data: { environmentId: envId, status: 'SUCCESS', containerName: 'live-container', commitSha: 'b'.repeat(40), finishedAt: now } });
    await prisma.deployment.create({ data: { environmentId: envId, status: 'ROLLED_BACK', commitSha: 'c'.repeat(40), finishedAt: now } });
  });

  const scrape = async () => (await http().get('/metrics').expect(200)).text as string;

  it('serves Prometheus text format at /metrics, and not under the public /api/v1 prefix', async () => {
    const res = await http().get('/metrics').expect(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.text).toContain('# TYPE aegisops_http_requests_total counter');
    expect(res.text).toContain('aegisops_http_request_duration_seconds_bucket');
    expect(res.text).toContain('aegisops_process_cpu_user_seconds_total');
    await http().get('/api/v1/metrics').expect(404);
  });

  it('counts requests by route PATTERN and status class, never by raw URL or user', async () => {
    await http().get(`/api/v1/projects/${projectId}`).set(as('it-devops')).expect(200);
    await http().get('/api/v1/projects').expect(401);
    const text = await scrape();
    expect(text).toMatch(/aegisops_http_requests_total\{method="GET",route="\/api\/v1\/projects\/:projectId",status_class="2xx"\} \d+/);
    expect(text).toMatch(/status_class="4xx"/);
    expect(text).not.toContain(projectId);
    expect(text).not.toContain('it-devops');
    expect(text).not.toContain(tokens['it-devops']);
  });

  it('reports one expected container per environment: the newest successful deployment', async () => {
    const text = await scrape();
    expect(text).toContain('aegisops_environment_expected_up{project="metrics-proj",environment="staging",name="live-container"} 1');
    expect(text).not.toContain('old-container');
  });

  it('reports deployment counts by outcome (used by the DeploymentFailed alert)', async () => {
    const text = await scrape();
    expect(text).toContain('aegisops_deployments_total{project="metrics-proj",environment="staging",status="SUCCESS"} 2');
    expect(text).toContain('aegisops_deployments_total{project="metrics-proj",environment="staging",status="ROLLED_BACK"} 1');
  });

  it('exposes queue depth series (empty when the queue stub has no counts)', async () => {
    const text = await scrape();
    expect(text).toContain('# TYPE aegisops_deploy_queue_jobs gauge');
  });
});

describe('monitoring overview: visibility, links and degradation (FR-DASH-1..4)', () => {
  let aId: string;
  let bId: string;
  let aStaging: string;

  beforeAll(async () => {
    aId = (await http().post('/api/v1/projects').set(as('it-devops')).send({ name: 'Dash A', slug: 'dash-a' }).expect(201)).body.id;
    bId = (await http().post('/api/v1/projects').set(as('it-admin')).send({ name: 'Dash B', slug: 'dash-b' }).expect(201)).body.id;
    aStaging = (await http().post(`/api/v1/projects/${aId}/environments`).set(as('it-devops')).send({ name: 'staging' }).expect(201)).body.id;
    await http().post(`/api/v1/projects/${bId}/environments`).set(as('it-admin')).send({ name: 'staging' }).expect(201);
    await http().post(`/api/v1/projects/${aId}/members`).set(as('it-devops')).send({ username: 'it-dev-a' }).expect(201);
    // project A staging has a live container; project B none
    await prisma.deployment.create({ data: { environmentId: aStaging, status: 'SUCCESS', containerName: 'dash-a-live', commitSha: 'a'.repeat(40), finishedAt: new Date() } });
    monitoring.available = true;
    monitoring.up = 1;
  });

  const overview = (user: string) => http().get('/api/v1/monitoring/overview').set(as(user));
  const names = (body: any) => body.projects.map((p: any) => p.slug).filter((s: string) => s.startsWith('dash-')).sort();

  it('a developer sees only the projects they are a member of, with no platform roll-up and no Grafana links', async () => {
    const res = await overview('it-dev-a').expect(200);
    expect(names(res.body)).toEqual(['dash-a']);
    expect(res.body.platform).toBeUndefined();
    const env = res.body.projects.find((p: any) => p.slug === 'dash-a').environments[0];
    expect(env.links).toBeUndefined(); // Grafana refuses developers, so no dead links
    expect(env).toMatchObject({ name: 'staging', state: 'up', container: 'dash-a-live' });
    expect(env.deployment.status).toBe('SUCCESS');
  });

  it('a non-member developer sees none of these projects, and receives no alerts about them', async () => {
    const res = await overview('it-dev-b').expect(200);
    expect(names(res.body)).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain('dash-a');
    expect(JSON.stringify(res.body)).not.toContain('HostMemoryHigh'); // platform alerts are for platform roles only
  });

  it('the auditor and platform admin see every project and the platform roll-up; links point at the right dashboards', async () => {
    for (const u of ['it-auditor', 'it-admin']) {
      const res = await overview(u).expect(200);
      expect(names(res.body)).toEqual(['dash-a', 'dash-b']);
      expect(res.body.platform).toMatchObject({ containersUp: 17, containersTotal: 17 });
      expect(res.body.platform.alerts.map((a: any) => a.name)).toContain('HostMemoryHigh');
      expect(res.body.platform.links.dashboard).toBe('https://grafana.test.example/d/aegisops-platform');
      const env = res.body.projects.find((p: any) => p.slug === 'dash-a').environments[0];
      expect(env.links.dashboard).toContain('var-project=dash-a&var-environment=staging');
    }
  });

  it('a devops engineer sees their projects with links but not the platform roll-up', async () => {
    const res = await overview('it-devops').expect(200);
    expect(res.body.platform).toBeUndefined();
    expect(res.body.projects.find((p: any) => p.slug === 'dash-a').environments[0].links.logs).toContain('/explore?');
  });

  it('a crashed container is reported down, and its alert appears on that environment only', async () => {
    monitoring.up = 0;
    monitoring.alerts = [{ name: 'ContainerDown', severity: 'critical', summary: 'Container dash-a-live is down (dash-a/staging)', since: new Date().toISOString(), project: 'dash-a', environment: 'staging' }];
    try {
      const mine = (await overview('it-dev-a').expect(200)).body.projects.find((p: any) => p.slug === 'dash-a');
      expect(mine.environments[0].state).toBe('down');
      expect(mine.environments[0].alerts.map((a: any) => a.name)).toEqual(['ContainerDown']);
      expect(mine.openAlerts).toBe(1);
      // another project's owner is told nothing about it
      expect(JSON.stringify((await overview('it-dev-b').expect(200)).body)).not.toContain('ContainerDown');
    } finally {
      monitoring.up = 1;
      monitoring.alerts = [{ name: 'HostMemoryHigh', severity: 'warning', summary: 'Host memory above 90%', since: new Date().toISOString() }];
    }
  });

  it('degrades to unknown (never a false "up") when Prometheus is unreachable, and still answers 200 with deployment state', async () => {
    monitoring.available = false;
    try {
      const res = await overview('it-dev-a').expect(200);
      expect(res.body.monitoring).toBe('unavailable');
      const env = res.body.projects.find((p: any) => p.slug === 'dash-a').environments[0];
      expect(env.state).toBe('unknown');
      expect(env.deployment.status).toBe('SUCCESS');
    } finally {
      monitoring.available = true;
    }
  });

  it('requires authentication', async () => {
    await http().get('/api/v1/monitoring/overview').expect(401);
  });
});

describe('database management and backups API: roles, confirmation and no leakage (FR-DB-1..4)', () => {
  let projectId: string;
  let stagingId: string;
  let prodId: string;
  let otherProjectId: string;
  let otherEnvId: string;
  let dbId: string;
  let okBackup: string;
  let failedBackup: string;
  let expiredBackup: string;
  let otherDbBackup: string;
  const base = () => `/api/v1/projects/${projectId}/databases`;
  const jobs = () => dataJobs.filter((j) => j.name !== 'noop');
  const lastJob = () => dataJobs[dataJobs.length - 1];

  beforeAll(async () => {
    projectId = (await http().post('/api/v1/projects').set(as('it-devops')).send({ name: 'Data', slug: 'data-proj' }).expect(201)).body.id;
    stagingId = (await http().post(`/api/v1/projects/${projectId}/environments`).set(as('it-devops')).send({ name: 'staging' }).expect(201)).body.id;
    prodId = (await http().post(`/api/v1/projects/${projectId}/environments`).set(as('it-devops')).send({ name: 'production', isProduction: true }).expect(201)).body.id;
    otherProjectId = (await http().post('/api/v1/projects').set(as('it-admin')).send({ name: 'Data Other', slug: 'data-other' }).expect(201)).body.id;
    otherEnvId = (await http().post(`/api/v1/projects/${otherProjectId}/environments`).set(as('it-admin')).send({ name: 'staging' }).expect(201)).body.id;
    await http().post(`/api/v1/projects/${projectId}/members`).set(as('it-devops')).send({ username: 'it-dev-a' }).expect(201);

    // a READY database with backups in each state, as the data worker would have left them
    const db = await prisma.database.create({ data: { projectId, environmentId: stagingId, name: 'main', pgName: 'app_data_aaaaaa', roleName: 'app_data_aaaaaa_u', status: 'READY' } });
    dbId = db.id;
    const mk = (extra: object) => prisma.backupJob.create({ data: { target: `db:${db.id}`, databaseId: db.id, objectKey: 'secret/path/archive.enc', sha256: 'f'.repeat(64), manifest: { 'public.t': 1 }, ...extra } });
    okBackup = (await mk({ status: 'SUCCESS', sizeBytes: BigInt(1234), plainBytes: BigInt(9999), finishedAt: new Date() })).id;
    failedBackup = (await mk({ status: 'FAILED', error: 'pg_dump failed', finishedAt: new Date() })).id;
    expiredBackup = (await mk({ status: 'SUCCESS', deletedAt: new Date(), finishedAt: new Date() })).id;
    const otherDb = await prisma.database.create({ data: { projectId: otherProjectId, environmentId: otherEnvId, name: 'theirs', pgName: 'app_data_bbbbbb', roleName: 'app_data_bbbbbb_u', status: 'READY' } });
    otherDbBackup = (await prisma.backupJob.create({ data: { target: `db:${otherDb.id}`, databaseId: otherDb.id, status: 'SUCCESS', objectKey: 'x', sha256: 'e'.repeat(64), finishedAt: new Date() } })).id;
  });

  describe('provisioning (FR-DB-1)', () => {
    it('only a platform admin or a devops engineer of the project can provision; developers and auditors cannot', async () => {
      const body = { name: 'orders', environmentId: prodId };
      await http().post(base()).set(as('it-dev-a')).send(body).expect(403);
      await http().post(base()).set(as('it-auditor')).send(body).expect(403);
      await http().post(base()).send(body).expect(401);
    });

    it('queues provisioning, reserves generated names, and never returns internal names or credentials', async () => {
      const before = dataJobs.length;
      const res = await http().post(base()).set(as('it-devops')).send({ name: 'orders', environmentId: prodId }).expect(202);
      expect(res.body).toMatchObject({ name: 'orders', environmentId: prodId, status: 'PROVISIONING' });
      expect(JSON.stringify(res.body)).not.toMatch(/app_data|_u\b|postgres/);
      expect(dataJobs.length).toBe(before + 1);
      expect(lastJob()).toMatchObject({ name: 'provision-db', data: { databaseId: res.body.id } });
      const row = await prisma.database.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(row.pgName).toMatch(/^app_data_proj_[0-9a-f]{6}$/);
      expect(row.roleName).toBe(`${row.pgName}_u`);
      expect(row.status).toBe('PROVISIONING');
      expect(await auditActions({ action: 'database.request' })).toContain('database.request:SUCCESS');
    });

    it('validates the input and refuses duplicates, wrong-project environments and a pre-existing DATABASE_URL', async () => {
      await http().post(base()).set(as('it-devops')).send({ name: 'Bad Name!', environmentId: stagingId }).expect(400);
      await http().post(base()).set(as('it-devops')).send({ name: 'x', environmentId: 'not-a-uuid' }).expect(400);
      await http().post(base()).set(as('it-devops')).send({ name: 'orders2', environmentId: otherEnvId }).expect(404); // another project's environment
      await http().post(base()).set(as('it-devops')).send({ name: 'again', environmentId: prodId }).expect(409);       // production already has one
      await http().post(base()).set(as('it-devops')).send({ name: 'main', environmentId: stagingId }).expect(409);     // staging already has 'main'
      // an environment that already has a DATABASE_URL secret is not silently overwritten
      const env3 = (await http().post(`/api/v1/projects/${projectId}/environments`).set(as('it-devops')).send({ name: 'qa' }).expect(201)).body.id;
      await http().put(`/api/v1/projects/${projectId}/environments/${env3}/secrets/DATABASE_URL`).set(as('it-devops')).send({ value: 'postgresql://x' }).expect(200);
      await http().post(base()).set(as('it-devops')).send({ name: 'qadb', environmentId: env3 }).expect(409);
    });

    it('a failed earlier attempt does not block a retry', async () => {
      const env4 = (await http().post(`/api/v1/projects/${projectId}/environments`).set(as('it-devops')).send({ name: 'retry' }).expect(201)).body.id;
      const first = await http().post(base()).set(as('it-devops')).send({ name: 'retrydb', environmentId: env4 }).expect(202);
      await prisma.database.update({ where: { id: first.body.id }, data: { status: 'FAILED', error: 'boom' } });
      await http().post(base()).set(as('it-devops')).send({ name: 'retrydb2', environmentId: env4 }).expect(202);
    });

    it('listing is visible to project members (developers see status, never internals); non-members get 404', async () => {
      const res = await http().get(base()).set(as('it-dev-a')).expect(200);
      expect(res.body.length).toBeGreaterThanOrEqual(2);
      for (const d of res.body) expect(Object.keys(d).sort()).toEqual(['createdAt', 'environmentId', 'error', 'id', 'name', 'status']);
      await http().get(base()).set(as('it-dev-b')).expect(404);
    });
  });

  describe('backup history and on-demand backups (FR-DB-3)', () => {
    it('history is for platform admins, auditors and the project devops engineer; developers are refused; non-members get 404', async () => {
      for (const u of ['it-devops', 'it-admin', 'it-auditor']) await http().get(`${base()}/${dbId}/backups`).set(as(u)).expect(200);
      await http().get(`${base()}/${dbId}/backups`).set(as('it-dev-a')).expect(403);
      await http().get(`${base()}/${dbId}/backups`).set(as('it-dev-b')).expect(403);
    });

    it('history shows status, size and errors, but never the storage key, checksum or manifest', async () => {
      const res = await http().get(`${base()}/${dbId}/backups`).set(as('it-devops')).expect(200);
      const byId = Object.fromEntries(res.body.backups.map((b: any) => [b.id, b]));
      expect(byId[okBackup]).toMatchObject({ status: 'SUCCESS', sizeBytes: 1234, plainBytes: 9999, expired: false });
      expect(byId[failedBackup]).toMatchObject({ status: 'FAILED', error: 'pg_dump failed' });
      expect(byId[expiredBackup].expired).toBe(true);
      const text = JSON.stringify(res.body);
      for (const secret of ['secret/path', 'ffffffff', 'objectKey', 'sha256', 'manifest', 'public.t']) expect(text).not.toContain(secret);
    });

    it("a project's backups are not visible through another project's URL", async () => {
      const theirs = await prisma.database.findFirstOrThrow({ where: { projectId: otherProjectId } });
      await http().get(`${base()}/${theirs.id}/backups`).set(as('it-devops')).expect(404);
    });

    it('on-demand backup: devops engineer or admin; queued, audited; refused for developers/auditors and not-ready databases', async () => {
      const before = dataJobs.length;
      await http().post(`${base()}/${dbId}/backups`).set(as('it-devops')).expect(202);
      await http().post(`${base()}/${dbId}/backups`).set(as('it-admin')).expect(202);
      expect(dataJobs.length).toBe(before + 2);
      expect(lastJob()).toMatchObject({ name: 'backup', data: { target: `db:${dbId}` } });
      await http().post(`${base()}/${dbId}/backups`).set(as('it-dev-a')).expect(403);
      await http().post(`${base()}/${dbId}/backups`).set(as('it-auditor')).expect(403);
      expect(await auditActions({ action: 'backup.request' })).toContain('backup.request:SUCCESS');
      const pending = (await http().get(base()).set(as('it-devops'))).body.find((d: any) => d.status === 'PROVISIONING');
      await http().post(`${base()}/${pending.id}/backups`).set(as('it-devops')).expect(409);
    });
  });

  describe('restore to a NEW database (FR-DB-4)', () => {
    it('devops engineers and admins can queue it; developers and auditors cannot', async () => {
      const before = dataJobs.length;
      await http().post(`${base()}/${dbId}/backups/${okBackup}/restore`).set(as('it-devops')).send({ reason: 'inspect last night' }).expect(202);
      expect(lastJob()).toMatchObject({ name: 'restore', data: { backupJobId: okBackup, reason: 'inspect last night' } });
      await http().post(`${base()}/${dbId}/backups/${okBackup}/restore`).set(as('it-dev-a')).send({}).expect(403);
      await http().post(`${base()}/${dbId}/backups/${okBackup}/restore`).set(as('it-auditor')).send({}).expect(403);
      expect(dataJobs.length).toBe(before + 1);
    });

    it('only a successful, unexpired backup of THAT database can be restored', async () => {
      await http().post(`${base()}/${dbId}/backups/${failedBackup}/restore`).set(as('it-devops')).send({}).expect(409);
      await http().post(`${base()}/${dbId}/backups/${expiredBackup}/restore`).set(as('it-devops')).send({}).expect(409);
      await http().post(`${base()}/${dbId}/backups/${otherDbBackup}/restore`).set(as('it-devops')).send({}).expect(404); // another project's backup
      await http().post(`${base()}/${dbId}/backups/00000000-0000-0000-0000-000000000000/restore`).set(as('it-devops')).send({}).expect(404);
    });
  });

  describe('overwrite: a separate, confirmed, admin-only step (FR-DB-4)', () => {
    const url = () => `${base()}/${dbId}/backups/${okBackup}/overwrite`;
    const good = { confirm: 'main', reason: 'roll back the bad import' };

    it('is platform_admin ONLY: a devops engineer of the project, a developer and an auditor are all refused', async () => {
      const before = dataJobs.length;
      for (const u of ['it-devops', 'it-dev-a', 'it-auditor']) await http().post(url()).set(as(u)).send(good).expect(403);
      expect(dataJobs.length).toBe(before); // nothing was queued
    });

    it('needs the database name typed back and a real reason', async () => {
      const before = dataJobs.length;
      await http().post(url()).set(as('it-admin')).send({ confirm: 'Main', reason: good.reason }).expect(400);
      await http().post(url()).set(as('it-admin')).send({ confirm: 'wrong', reason: good.reason }).expect(400);
      await http().post(url()).set(as('it-admin')).send({ confirm: 'main', reason: 'short' }).expect(400);
      await http().post(url()).set(as('it-admin')).send({ confirm: 'main' }).expect(400);
      await http().post(url()).set(as('it-admin')).send({ reason: good.reason }).expect(400);
      expect(dataJobs.length).toBe(before);
    });

    it('queues exactly one overwrite job with the reason, and audits the request', async () => {
      const before = dataJobs.length;
      await http().post(url()).set(as('it-admin')).send(good).expect(202);
      expect(dataJobs.length).toBe(before + 1);
      expect(lastJob()).toMatchObject({ name: 'overwrite', data: { backupJobId: okBackup, reason: good.reason } });
      expect(await auditActions({ action: 'backup.overwrite.request' })).toContain('backup.overwrite.request:SUCCESS');
    });

    it('cannot overwrite from a failed, expired or foreign backup', async () => {
      for (const b of [failedBackup, expiredBackup]) await http().post(`${base()}/${dbId}/backups/${b}/overwrite`).set(as('it-admin')).send(good).expect(409);
      await http().post(`${base()}/${dbId}/backups/${otherDbBackup}/overwrite`).set(as('it-admin')).send(good).expect(404);
    });
  });

  describe('system databases, drills and restore history (FR-BACKUP-4/5)', () => {
    it('the overview is for platform admins and auditors only', async () => {
      for (const u of ['it-admin', 'it-auditor']) {
        const res = await http().get('/api/v1/backups/overview').set(as(u)).expect(200);
        expect(res.body.targets.map((t: any) => t.target)).toEqual(['system:aegisops', 'system:keycloak']);
        expect(res.body.rtoSeconds).toBe(14400);
      }
      for (const u of ['it-devops', 'it-dev-a']) await http().get('/api/v1/backups/overview').set(as(u)).expect(403);
    });

    it('only a platform admin can back up a system database or start a drill', async () => {
      const before = dataJobs.length;
      await http().post('/api/v1/backups/system/aegisops').set(as('it-admin')).expect(202);
      await http().post('/api/v1/backups/system/keycloak').set(as('it-admin')).expect(202);
      await http().post('/api/v1/backups/drill').set(as('it-admin')).expect(202);
      expect(dataJobs.slice(before).map((j) => j.name)).toEqual(['backup', 'backup', 'drill']);
      await http().post('/api/v1/backups/system/nothing').set(as('it-admin')).expect(404);
      await http().post('/api/v1/backups/system/aegisops%27;DROP').set(as('it-admin')).expect(404);
      for (const u of ['it-devops', 'it-dev-a', 'it-auditor']) {
        await http().post('/api/v1/backups/system/aegisops').set(as(u)).expect(403);
        await http().post('/api/v1/backups/drill').set(as(u)).expect(403);
      }
    });

    it('restore history is for platform admins and auditors, and is bounded', async () => {
      await prisma.restoreJob.create({ data: { backupJobId: okBackup, kind: 'DRILL', status: 'SUCCESS', targetDatabase: 'drill_aaaaaaaa', durationMs: 1500, finishedAt: new Date(), integrity: { ok: true, tables: 3, rows: 10, withinRto: true } } });
      const res = await http().get('/api/v1/restores?limit=5').set(as('it-auditor')).expect(200);
      expect(res.body.length).toBeLessThanOrEqual(5);
      expect(res.body[0]).toMatchObject({ kind: 'DRILL', status: 'SUCCESS', durationMs: 1500, integrity: { ok: true, withinRto: true } });
      expect((await http().get('/api/v1/restores?limit=100000').set(as('it-admin')).expect(200)).body.length).toBeLessThanOrEqual(100);
      await http().get('/api/v1/restores').set(as('it-devops')).expect(403);
    });
  });
});

describe('infrastructure management: servers, container controls, logs, cordon and drain (FR-INFRA-1..3)', () => {
  let projectId: string;
  let stagingId: string;
  let prodId: string;
  let serverId: string;
  const SHA = 'c'.repeat(40);
  const lastContainerJob = () => containerJobs[containerJobs.length - 1];
  const deployUrl = (envId: string) => `/api/v1/projects/${projectId}/environments/${envId}/deployments`;

  beforeAll(async () => {
    projectId = (await http().post('/api/v1/projects').set(as('it-devops')).send({ name: 'Infra', slug: 'infra-proj', githubRepo: 'acme/infra-proj' }).expect(201)).body.id;
    stagingId = (await http().post(`/api/v1/projects/${projectId}/environments`).set(as('it-devops')).send({ name: 'staging' }).expect(201)).body.id;
    prodId = (await http().post(`/api/v1/projects/${projectId}/environments`).set(as('it-devops')).send({ name: 'production', isProduction: true }).expect(201)).body.id;
    await http().post(`/api/v1/projects/${projectId}/members`).set(as('it-devops')).send({ username: 'it-dev-a' }).expect(201);
  });

  describe('servers (FR-INFRA-1)', () => {
    it('platform admins, devops engineers and auditors can list servers; developers cannot', async () => {
      for (const u of ['it-admin', 'it-devops', 'it-auditor']) await http().get('/api/v1/infra/servers').set(as(u)).expect(200);
      await http().get('/api/v1/infra/servers').set(as('it-dev-a')).expect(403);
      await http().get('/api/v1/infra/servers').expect(401);
    });

    it('registers the single droplet as "primary" on first use and shows its containers and environments', async () => {
      const res = await http().get('/api/v1/infra/servers').set(as('it-admin')).expect(200);
      const primary = res.body.find((s: any) => s.name === 'primary');
      expect(primary).toMatchObject({ role: 'app', cordoned: false });
      expect(primary.environments).toBeGreaterThanOrEqual(2); // environments with no explicit server belong to it
      expect(primary.containers.map((c: any) => c.name)).toContain('aegisops-api');
      serverId = primary.id;
      expect((await http().get('/api/v1/infra/servers').set(as('it-admin'))).body.filter((s: any) => s.name === 'primary')).toHaveLength(1); // idempotent
    });

    it('registering a server is platform_admin only, validated, and refuses duplicates', async () => {
      await http().post('/api/v1/infra/servers').set(as('it-devops')).send({ name: 'second' }).expect(403);
      await http().post('/api/v1/infra/servers').set(as('it-admin')).send({ name: 'Bad Name!' }).expect(400);
      await http().post('/api/v1/infra/servers').set(as('it-admin')).send({ name: 'second', ipAddress: 'not-an-ip' }).expect(400);
      await http().post('/api/v1/infra/servers').set(as('it-admin')).send({ name: 'second', cpuCores: 0 }).expect(400);
      await http().post('/api/v1/infra/servers').set(as('it-admin')).send({ name: 'second', ipAddress: '10.0.0.7', cpuCores: 4, memoryMb: 8192 }).expect(201);
      await http().post('/api/v1/infra/servers').set(as('it-admin')).send({ name: 'second' }).expect(409);
    });
  });

  describe('container controls (FR-INFRA-2)', () => {
    const ctl = (user: string, envId: string, action: string) => http().post(`/api/v1/projects/${projectId}/environments/${envId}/container/${action}`).set(as(user));

    it('a developer member can restart a NON-production container; the job carries the environment id, never a container name', async () => {
      const before = containerJobs.length;
      await ctl('it-dev-a', stagingId, 'restart').expect(202);
      expect(containerJobs.length).toBe(before + 1);
      expect(lastContainerJob()).toEqual({ kind: 'environment', environmentId: stagingId, action: 'restart', requestedById: expect.any(String) });
      expect(await auditActions({ action: 'container.request' })).toContain('container.request:SUCCESS');
    });

    it('production containers need devops_engineer or platform_admin (same rule as deploying)', async () => {
      await ctl('it-dev-a', prodId, 'restart').expect(403);
      await ctl('it-devops', prodId, 'stop').expect(202);
      await ctl('it-admin', prodId, 'start').expect(202);
    });

    it('auditors are read-only; non-members get 404; unknown actions are rejected', async () => {
      const before = containerJobs.length;
      await ctl('it-auditor', stagingId, 'restart').expect(403);
      await ctl('it-dev-b', stagingId, 'restart').expect(404);
      await ctl('it-devops', stagingId, 'kill').expect(400);
      await ctl('it-devops', stagingId, 'restart; rm -rf /').expect(400);
      await ctl('it-devops', stagingId, 'exec').expect(400);
      expect(containerJobs.length).toBe(before);
    });

    it("an environment of another project is unreachable through this project's URL", async () => {
      const other = (await http().post('/api/v1/projects').set(as('it-admin')).send({ name: 'Elsewhere', slug: 'elsewhere' }).expect(201)).body.id;
      const otherEnv = (await http().post(`/api/v1/projects/${other}/environments`).set(as('it-admin')).send({ name: 'staging' }).expect(201)).body.id;
      await ctl('it-devops', otherEnv, 'restart').expect(404);
    });

    it('platform containers: platform_admin only, a typed reason, exact allowlisted names', async () => {
      const plat = (user: string, name: string, action: string, body: object = { reason: 'dashboards stuck, restarting' }) =>
        http().post(`/api/v1/infra/containers/${name}/${action}`).set(as(user)).send(body);
      const before = containerJobs.length;
      await plat('it-admin', 'aegisops-grafana', 'restart').expect(202);
      expect(lastContainerJob()).toMatchObject({ kind: 'platform', name: 'aegisops-grafana', action: 'restart', reason: 'dashboards stuck, restarting' });
      await plat('it-admin', 'aegisops-grafana', 'stop').expect(202);
      for (const u of ['it-devops', 'it-dev-a', 'it-auditor']) await plat(u, 'aegisops-grafana', 'restart').expect(403);
      await plat('it-admin', 'aegisops-grafana', 'restart', { reason: 'short' }).expect(400);
      await plat('it-admin', 'aegisops-grafana', 'restart', {}).expect(400);
      await plat('it-admin', 'tega_rw_backend', 'restart').expect(400);            // someone else's container on this host
      await plat('it-admin', 'aegisops-deployer', 'restart').expect(400);          // the executor itself
      await plat('it-admin', 'aegisops-redis', 'stop').expect(400);                // critical: restart only
      await plat('it-admin', 'aegisops-api', 'stop').expect(400);
      await plat('it-admin', 'aegisops-nginx', 'restart').expect(202);             // critical, but restart is allowed
      expect(containerJobs.length).toBe(before + 3);
    });
  });

  describe('logs (FR-INFRA-2)', () => {
    const logs = (user: string, qs = '') => http().get(`/api/v1/projects/${projectId}/environments/${stagingId}/logs${qs}`).set(as(user));

    it('project members (including developers) and operators can read THEIR environment logs; non-members cannot', async () => {
      for (const u of ['it-dev-a', 'it-devops', 'it-admin', 'it-auditor']) {
        const res = await logs(u).expect(200);
        expect(res.body.lines[0]).toMatchObject({ container: 'aegis-infra-proj-staging-1', line: 'listening on 3000' });
      }
      await logs('it-dev-b').expect(404);
      await http().get(`/api/v1/projects/${projectId}/environments/${stagingId}/logs`).expect(401);
    });

    it('the query is bound to this project and environment, with bounded size and range', async () => {
      logCalls.length = 0;
      await logs('it-dev-a', '?minutes=30&limit=50&q=error').expect(200);
      expect(logCalls[0]).toEqual({ project: 'infra-proj', environment: 'staging', opts: { minutes: 30, limit: 50, contains: 'error' } });
      await logs('it-dev-a', '?minutes=0').expect(400);
      await logs('it-dev-a', '?minutes=100000').expect(400);
      await logs('it-dev-a', '?limit=501').expect(400);
      await logs('it-dev-a', `?q=${'x'.repeat(101)}`).expect(400);
    });

    it('reports log search as unavailable (503) instead of failing opaquely', async () => {
      infraStub.lokiDown = true;
      try { await logs('it-dev-a').expect(503); } finally { infraStub.lokiDown = false; }
    });
  });

  describe('cordon and drain (FR-INFRA-3)', () => {
    const act = (action: string, user: string, body: object) => http().post(`/api/v1/infra/servers/${serverId}/${action}`).set(as(user)).send(body);
    const good = { confirm: 'primary', reason: 'kernel upgrade window' };

    it('are platform_admin only, and need the server name typed back plus a real reason', async () => {
      const before = containerJobs.length;
      for (const a of ['cordon', 'uncordon', 'drain']) {
        for (const u of ['it-devops', 'it-dev-a', 'it-auditor']) await act(a, u, good).expect(403);
        await act(a, 'it-admin', { confirm: 'Primary', reason: good.reason }).expect(400);
        await act(a, 'it-admin', { confirm: 'wrong', reason: good.reason }).expect(400);
        await act(a, 'it-admin', { confirm: 'primary', reason: 'short' }).expect(400);
        await act(a, 'it-admin', { reason: good.reason }).expect(400);
      }
      expect(containerJobs.length).toBe(before);
      expect((await http().get('/api/v1/infra/servers').set(as('it-admin'))).body.find((s: any) => s.name === 'primary').cordoned).toBe(false);
    });

    it('a drain on a server that is NOT cordoned is refused', async () => {
      const before = containerJobs.length;
      await act('drain', 'it-admin', good).expect(409);
      expect(containerJobs.length).toBe(before);
    });

    it('cordoning records who and why in the audit log, and BLOCKS new deployments on every path', async () => {
      await act('cordon', 'it-admin', good).expect(200);
      const entry = await prisma.auditLogEntry.findFirstOrThrow({ where: { action: 'server.cordon' }, orderBy: { createdAt: 'desc' } });
      expect(entry.metadata).toMatchObject({ server: 'primary', reason: 'kernel upgrade window' });
      expect(entry.actorName).toBe('it-admin');

      // manual deploy, rollback, CI key and webhook: none create a deployment while cordoned
      const countBefore = await prisma.deployment.count({ where: { environmentId: stagingId } });
      await http().post(deployUrl(stagingId)).set(as('it-devops')).send({ commitSha: SHA }).expect(409);
      const ok = await prisma.deployment.create({ data: { environmentId: stagingId, status: 'SUCCESS', imageRef: 'ghcr.io/acme/infra-proj:old', commitSha: SHA } });
      await http().post(`${deployUrl(stagingId)}/${ok.id}/rollback`).set(as('it-devops')).expect(409);
      const key = (await http().post(`/api/v1/projects/${projectId}/api-keys`).set(as('it-devops')).send({ name: 'ci', scopes: ['deployments:trigger'] }).expect(201)).body.key;
      await http().post('/api/v1/ci/deployments').set('X-API-Key', key).send({ environment: 'staging', commitSha: SHA }).expect(409);
      const hook = await signedWorkflowRun('acme/infra-proj', SHA, 'main');
      expect(hook.status).toBe(201);
      expect(hook.body).toEqual({ deployments: [] }); // GitHub's delivery still succeeds, but nothing is deployed
      expect(await prisma.deployment.count({ where: { environmentId: stagingId } })).toBe(countBefore + 1); // only the SUCCESS row seeded above
    });

    it('drain then queues exactly one job carrying the reason; existing containers are not touched by the cordon itself', async () => {
      const before = containerJobs.length;
      await act('drain', 'it-admin', good).expect(202);
      expect(containerJobs.length).toBe(before + 1);
      expect(lastContainerJob()).toMatchObject({ kind: 'drain', serverId, reason: 'kernel upgrade window' });
      expect(await auditActions({ action: 'server.drain.request' })).toContain('server.drain.request:SUCCESS');
    });

    it('uncordon re-opens the server: deployments work again', async () => {
      await act('uncordon', 'it-admin', good).expect(200);
      await http().post(deployUrl(stagingId)).set(as('it-devops')).send({ commitSha: SHA }).expect(201);
      expect(await auditActions({ action: 'server.uncordon' })).toContain('server.uncordon:SUCCESS');
    });
  });
});
