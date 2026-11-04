/**
 * Deployment Engine against REAL Docker, a REAL Nginx container and a REAL Postgres (PRD 6.4, FR-DEPLOY-2/4/5).
 * Uses the sample app images built from apps/sample-app: aegisops-sample:good and aegisops-sample:bad
 * (`bad` is built with HEALTH_OVERRIDE=broken, so its /healthz returns 500). Needs Docker.
 */
import 'reflect-metadata';
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import Docker from 'dockerode';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaClient } from '@prisma/client';
import { DeployEngine } from '../src/deployments/deploy-engine';
import { DockerodeOps, NginxRouter, Router } from '../src/deployments/docker-ops';
import { AuditService } from '../src/audit/audit.service';

jest.setTimeout(300_000);

const SAMPLE = join(__dirname, '../../sample-app');
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

const docker = new Docker();
const suffix = randomBytes(3).toString('hex');
const network = `aegis-it-net-${suffix}`;
let pg: StartedPostgreSqlContainer;
let nginx: StartedTestContainer;
let prisma: PrismaClient;
let confDir: string;
let engine: DeployEngine;
let ops: DockerodeOps;
let projectId: string;

// fetch() silently drops a custom Host header, so use node:http.
function get(host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: nginx.getHost(), port: nginx.getMappedPort(80), path: '/', headers: { Host: host } }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function newEnv(name: string, domain: string | null) {
  return prisma.environment.create({
    data: { projectId, name, domain, imageRepo: 'aegisops-sample', containerPort: 3000, healthPath: '/healthz' },
  });
}
async function deploy(environmentId: string, imageRef: string, sha: string, extra: object = {}) {
  const d = await prisma.deployment.create({ data: { environmentId, imageRef, commitSha: sha, ...extra } });
  await engine.run(d.id);
  return prisma.deployment.findUniqueOrThrow({ where: { id: d.id } });
}
const managed = (slug: string, env: string) => ops.listManaged(slug, env);

beforeAll(async () => {
  // Real images for the tests. `docker build` is a no-op when cached.
  execSync(`docker build -q -t aegisops-sample:good "${SAMPLE}"`, { stdio: 'pipe' });
  execSync(`docker build -q --build-arg HEALTH_OVERRIDE=broken -t aegisops-sample:bad "${SAMPLE}"`, { stdio: 'pipe' });

  pg = await new PostgreSqlContainer('postgres:16-alpine').withDatabase('aegisops').start();
  execSync('npx prisma migrate deploy', { cwd: join(__dirname, '..'), env: { ...process.env, DATABASE_URL: pg.getConnectionUri() }, stdio: 'pipe' });
  prisma = new PrismaClient({ datasources: { db: { url: pg.getConnectionUri() } } });

  await docker.createNetwork({ Name: network });
  confDir = mkdtempSync(join(tmpdir(), 'aegis-nginx-'));
  const nginxName = `aegis-it-nginx-${suffix}`;
  const base = 'resolver 127.0.0.11 valid=5s ipv6=off;\nserver { listen 80 default_server; return 404; }\n';
  nginx = await new GenericContainer('nginx:stable-alpine')
    .withName(nginxName)
    .withNetwork({ getName: () => network, getId: () => network } as any)
    .withCopyContentToContainer([{ content: base, target: '/etc/nginx/conf.d/00-base.conf' }])
    .withBindMounts([{ source: confDir, target: '/etc/nginx/conf.d/managed', mode: 'rw' }])
    .withExposedPorts(80)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();
  // Include the managed directory (the real deployment writes straight into conf.d).
  await nginx.exec(['sh', '-c', `echo 'include /etc/nginx/conf.d/managed/*.conf;' > /etc/nginx/conf.d/10-managed.conf && nginx -s reload`]);

  ops = new DockerodeOps(docker, undefined, true);
  const audit = new AuditService(prisma as any);
  engine = new DeployEngine(prisma as any, audit, ops, new NginxRouter(docker, confDir, nginxName), {
    network, healthTimeoutMs: 20_000, healthIntervalMs: 1_000, tls: false, nginxContainer: nginxName,
  });
  projectId = (await prisma.project.create({ data: { name: 'Sample', slug: 'sample' } })).id;
});

afterAll(async () => {
  for (const env of ['staging', 'rollbacks', 'firstbad', 'noroute', 'inject', 'secretenv', 'cordon']) {
    for (const c of await ops.listManaged('sample', env).catch(() => [])) await ops.remove(c).catch(() => undefined);
  }
  await nginx?.stop().catch(() => undefined);
  await docker.getNetwork(network).remove().catch(() => undefined);
  await prisma?.$disconnect();
  await pg?.stop();
});

describe('deployment engine on real Docker + Nginx', () => {
  let staging: { id: string };
  let first: { id: string; containerName: string | null };

  it('deploys a healthy image, routes the domain to it, and records history', async () => {
    staging = await newEnv('staging', 'app.example.com');
    first = await deploy(staging.id, 'aegisops-sample:good', SHA_A);
    expect(first).toMatchObject({ status: 'SUCCESS' });
    expect(first.containerName).toMatch(/^aegis-sample-staging-/);

    const res = await get('app.example.com');
    expect(res.status).toBe(200);
    expect(res.body).toContain(`version ${SHA_A}`);

    const info = await docker.getContainer(first.containerName!).inspect();
    expect(info.Config.Labels).toMatchObject({ 'aegisops.managed': 'true', 'aegisops.project': 'sample', 'aegisops.environment': 'staging' });
    expect(info.HostConfig.CapDrop).toEqual(['ALL']);
    expect(info.HostConfig.SecurityOpt).toContain('no-new-privileges:true');
    expect(readdirSync(confDir)).toContain('project-sample-staging.conf');
  });

  it('a failing health check auto-rolls back: the broken container is never routed, the previous one stays live (FR-DEPLOY-5)', async () => {
    const bad = await deploy(staging.id, 'aegisops-sample:bad', SHA_B);
    expect(bad.status).toBe('ROLLED_BACK');
    expect(bad.failureReason).toMatch(/health check failed/);
    expect(bad.logs).toMatch(/still live/);

    // Previous version still serving through Nginx...
    const res = await get('app.example.com');
    expect(res.body).toContain(`version ${SHA_A}`);
    // ...the route file never mentioned the bad container...
    expect(readFileSync(join(confDir, 'project-sample-staging.conf'), 'utf8')).toContain(first.containerName!);
    // ...and the broken container is gone, the old one still running.
    expect(await managed('sample', 'staging')).toEqual([first.containerName]);
    expect((await docker.getContainer(first.containerName!).inspect()).State.Running).toBe(true);
  });

  it('a successful redeploy swaps traffic, then retires the old container', async () => {
    const second = await deploy(staging.id, 'aegisops-sample:good', SHA_C);
    expect(second.status).toBe('SUCCESS');
    expect((await get('app.example.com')).body).toContain(`version ${SHA_C}`);
    expect(await managed('sample', 'staging')).toEqual([second.containerName]);
  });

  it('one-click rollback restores an earlier successful deployment through the same health gate (FR-DEPLOY-4)', async () => {
    const rb = await deploy(staging.id, 'aegisops-sample:good', SHA_A, { triggerSource: 'rollback', restoredFromId: first.id });
    expect(rb.status).toBe('SUCCESS');
    expect(rb.restoredFromId).toBe(first.id);
    expect((await get('app.example.com')).body).toContain(`version ${SHA_A}`);
  });

  it('history is complete and ordered: success, rolled back, success, success', async () => {
    const hist = await prisma.deployment.findMany({ where: { environmentId: staging.id }, orderBy: { startedAt: 'asc' } });
    expect(hist.map((h) => h.status)).toEqual(['SUCCESS', 'ROLLED_BACK', 'SUCCESS', 'SUCCESS']);
  });

  it('an environment with no previous version reports FAILED (nothing to roll back to) and routes nothing', async () => {
    const env = await newEnv('firstbad', 'first.example.com');
    const d = await deploy(env.id, 'aegisops-sample:bad', SHA_B);
    expect(d.status).toBe('FAILED');
    expect(await managed('sample', 'firstbad')).toEqual([]);
    expect(readdirSync(confDir)).not.toContain('project-sample-firstbad.conf');
    expect((await get('first.example.com')).status).toBe(404);
  });

  it('a pull failure leaves the live version untouched', async () => {
    const d = await deploy(staging.id, 'aegisops-sample:does-not-exist', SHA_B);
    expect(d.status).toBe('ROLLED_BACK');
    expect((await get('app.example.com')).body).toContain(`version ${SHA_A}`);
  });

  it('an environment without a domain is health-gated but not routed', async () => {
    const env = await newEnv('noroute', null);
    const d = await deploy(env.id, 'aegisops-sample:good', SHA_A);
    expect(d.status).toBe('SUCCESS');
    expect(d.logs).toMatch(/not routed/);
  });

  it('a domain that tries to inject Nginx config is refused and the previous route survives', async () => {
    const env = await newEnv('inject', 'ok.example.com');
    const ok = await deploy(env.id, 'aegisops-sample:good', SHA_A);
    expect(ok.status).toBe('SUCCESS');
    await prisma.environment.update({ where: { id: env.id }, data: { domain: 'evil.com; return 200 pwned' } });
    const d = await deploy(env.id, 'aegisops-sample:good', SHA_C);
    expect(d.status).toBe('ROLLED_BACK');
    expect(d.failureReason).toMatch(/route switch failed/);
    expect((await get('ok.example.com')).body).toContain(`version ${SHA_A}`);
  });

  it('a route that makes `nginx -t` fail is rolled back and the old config is restored', async () => {
    const env = await prisma.environment.findFirstOrThrow({ where: { name: 'staging' } });
    const real = new NginxRouter(docker, confDir, `aegis-it-nginx-${suffix}`);
    const sabotaged: Router = { apply: (f) => real.apply(f, 'this is not valid nginx config;'), remove: (f) => real.remove(f) };
    const e2 = new DeployEngine(prisma as any, new AuditService(prisma as any), ops, sabotaged, {
      network, healthTimeoutMs: 20_000, healthIntervalMs: 1_000, tls: false, nginxContainer: `aegis-it-nginx-${suffix}`,
    });
    const dep = await prisma.deployment.create({ data: { environmentId: env.id, imageRef: 'aegisops-sample:good', commitSha: SHA_B } });
    await e2.run(dep.id);
    const after = await prisma.deployment.findUniqueOrThrow({ where: { id: dep.id } });
    expect(after.status).toBe('ROLLED_BACK');
    expect(after.failureReason).toMatch(/nginx -t failed/);
    expect((await get('app.example.com')).body).toContain(`version ${SHA_A}`); // Nginx still healthy, old route intact
  });

  it('re-running an already-handled deployment is a no-op (redelivered job)', async () => {
    const last = await prisma.deployment.findFirstOrThrow({ where: { status: 'SUCCESS' }, orderBy: { startedAt: 'desc' } });
    await engine.run(last.id);
    expect((await prisma.deployment.findUniqueOrThrow({ where: { id: last.id } })).status).toBe('SUCCESS');
  });
});

describe('secrets and GitHub reporting in the engine', () => {
  const VALUE = `s3cr3t-${randomBytes(6).toString('hex')}`;

  it('injects decrypted secrets into the container environment, never logs them, and reports to GitHub', async () => {
    const { SecretsCrypto } = await import('../src/secrets/secrets-crypto');
    const { SecretsService } = await import('../src/secrets/secrets.service');
    const secrets = SecretsService.withCrypto(prisma as any, new SecretsCrypto(randomBytes(32).toString('base64')));
    const reports: { kind: string; state?: string; ctx: any }[] = [];
    const reporter = {
      started: async (ctx: any) => { reports.push({ kind: 'started', ctx }); return 7; },
      finished: async (handle: unknown, ctx: any, state: string) => { reports.push({ kind: `finished:${handle}`, state, ctx }); },
    };
    await prisma.project.update({ where: { id: projectId }, data: { githubRepo: 'example-org/sample' } });
    const env = await newEnv('secretenv', null);
    await secrets.set(env.id, 'DEMO_TOKEN', VALUE);
    await secrets.set(env.id, 'PORT', '1').catch((e) => expect(String(e.message)).toMatch(/set by the platform/));

    const e2 = new DeployEngine(prisma as any, new AuditService(prisma as any), ops, new NginxRouter(docker, confDir, `aegis-it-nginx-${suffix}`), {
      network, healthTimeoutMs: 20_000, healthIntervalMs: 1_000, tls: false, nginxContainer: `aegis-it-nginx-${suffix}`, webOrigin: 'https://dash.example.com',
    }, secrets, reporter);
    const dep = await prisma.deployment.create({ data: { environmentId: env.id, imageRef: 'aegisops-sample:good', commitSha: SHA_A } });
    await e2.run(dep.id);

    const after = await prisma.deployment.findUniqueOrThrow({ where: { id: dep.id } });
    expect(after.status).toBe('SUCCESS');
    const inspect = await docker.getContainer(after.containerName!).inspect();
    expect(inspect.Config.Env).toContain(`DEMO_TOKEN=${VALUE}`);
    expect(inspect.Config.Env).toContain('PORT=3000'); // platform variables win
    expect(after.logs).toMatch(/injecting 1 secret environment variable/);
    expect(after.logs).not.toContain(VALUE);
    expect(after.logs).not.toContain('DEMO_TOKEN');
    const stored = await prisma.environmentSecret.findFirstOrThrow({ where: { environmentId: env.id } });
    expect(stored.valueEnc).not.toContain(VALUE);

    expect(reports.map((r) => r.kind)).toEqual(['started', 'finished:7']);
    expect(reports[1].state).toBe('success');
    expect(reports[0].ctx).toMatchObject({ repo: 'example-org/sample', sha: SHA_A, environment: 'secretenv', isProduction: false });
    expect(reports[0].ctx.logUrl).toBe(`https://dash.example.com/projects/${projectId}/deployments/${dep.id}?env=${env.id}`);
  });

  it('a failed deploy is reported as failure, and a broken reporter cannot break a deployment', async () => {
    const reports: string[] = [];
    // started() throws (GitHub down): the deployment must carry on and still report its outcome.
    const flaky = {
      started: async () => { throw new Error('github down'); },
      finished: async (_h: unknown, _c: any, state: string) => { reports.push(state); },
    };
    const env = await prisma.environment.findFirstOrThrow({ where: { name: 'secretenv' } });
    const e2 = new DeployEngine(prisma as any, new AuditService(prisma as any), ops, new NginxRouter(docker, confDir, `aegis-it-nginx-${suffix}`), {
      network, healthTimeoutMs: 20_000, healthIntervalMs: 1_000, tls: false, nginxContainer: `aegis-it-nginx-${suffix}`,
    }, undefined, flaky);
    const dep = await prisma.deployment.create({ data: { environmentId: env.id, imageRef: 'aegisops-sample:bad', commitSha: SHA_B } });
    await e2.run(dep.id);
    const after = await prisma.deployment.findUniqueOrThrow({ where: { id: dep.id } });
    expect(after.status).toBe('ROLLED_BACK');
    expect(reports).toEqual(['failure']);
  });
});

describe('cordon (FR-INFRA-3): a cordoned server accepts no new deployments, even one queued before the cordon', () => {
  it('refuses at run time: nothing is pulled or started, and the live version keeps serving', async () => {
    const env = await newEnv('cordon', 'cordon.example.com');
    const live = await deploy(env.id, 'aegisops-sample:good', SHA_A);
    expect(live.status).toBe('SUCCESS');
    expect((await get('cordon.example.com')).body).toContain(`version ${SHA_A}`);

    // a deployment was queued, THEN the server was cordoned
    const queued = await prisma.deployment.create({ data: { environmentId: env.id, imageRef: 'aegisops-sample:good', commitSha: SHA_B } });
    const server = await prisma.server.create({ data: { name: 'primary', role: 'app', cordoned: true, cordonReason: 'kernel upgrade' } });
    await engine.run(queued.id);

    const after = await prisma.deployment.findUniqueOrThrow({ where: { id: queued.id } });
    expect(after.status).toBe('ROLLED_BACK');
    expect(after.failureReason).toMatch(/cordoned/);
    expect(after.logs).toMatch(/Previous version .* is still live/);
    expect(after.containerName).toBeNull();
    expect(await managed('sample', 'cordon')).toEqual([live.containerName]); // no second container was started
    expect((await get('cordon.example.com')).body).toContain(`version ${SHA_A}`);

    // uncordon: the same deployment path works again
    await prisma.server.update({ where: { id: server.id }, data: { cordoned: false, cordonReason: null } });
    const next = await deploy(env.id, 'aegisops-sample:good', SHA_B);
    expect(next.status).toBe('SUCCESS');
    expect((await get('cordon.example.com')).body).toContain(`version ${SHA_B}`);
  });
});
