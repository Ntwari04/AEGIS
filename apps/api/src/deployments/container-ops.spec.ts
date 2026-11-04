import { ContainerOps, PLATFORM_CONTAINERS, platformActionAllowed, type ContainerAction, type ContainerDocker } from './container-ops';

function fakeDocker(containers: Record<string, Record<string, string>>) {
  const calls: { name: string; action: ContainerAction }[] = [];
  const docker: ContainerDocker = {
    labelsOf: async (n) => containers[n] ?? null,
    control: async (name, action) => { calls.push({ name, action }); },
    listManagedRunning: async () => Object.entries(containers).filter(([, l]) => l['aegisops.managed'] === 'true').map(([n]) => n),
  };
  return { docker, calls };
}

const audit: { action: string; result: string; metadata?: any }[] = [];
const auditor = { record: async (e: any) => void audit.push({ action: e.action, result: e.result, metadata: e.metadata }) };

function fakePrisma(opts: { env?: any; dep?: any; server?: any } = {}) {
  return {
    environment: { findUnique: async () => opts.env ?? null },
    deployment: { findFirst: async () => opts.dep ?? null },
    server: { findUnique: async () => opts.server ?? null },
  } as any;
}
const ENV = { id: 'e1', name: 'staging', project: { slug: 'shop' } };
const MANAGED = { 'aegisops.managed': 'true', 'aegisops.project': 'shop', 'aegisops.environment': 'staging' };

beforeEach(() => { audit.length = 0; });

describe('ContainerOps: environment containers (FR-INFRA-2)', () => {
  it('controls the container of the latest successful deployment, resolved from the database, and audits it', async () => {
    const { docker, calls } = fakeDocker({ 'aegis-shop-staging-1': MANAGED });
    const ops = new ContainerOps(fakePrisma({ env: ENV, dep: { containerName: 'aegis-shop-staging-1' } }), docker, auditor);
    await ops.run({ kind: 'environment', environmentId: 'e1', action: 'restart', requestedById: 'u1' });
    expect(calls).toEqual([{ name: 'aegis-shop-staging-1', action: 'restart' }]);
    expect(audit).toEqual([expect.objectContaining({ action: 'container.restart', result: 'SUCCESS', metadata: expect.objectContaining({ project: 'shop', environment: 'staging' }) })]);
  });

  it('refuses a container that is not managed, or managed for a DIFFERENT project or environment', async () => {
    for (const labels of [{}, { ...MANAGED, 'aegisops.managed': 'false' }, { ...MANAGED, 'aegisops.project': 'other' }, { ...MANAGED, 'aegisops.environment': 'production' }]) {
      const { docker, calls } = fakeDocker({ 'c': labels });
      const ops = new ContainerOps(fakePrisma({ env: ENV, dep: { containerName: 'c' } }), docker, auditor);
      await expect(ops.run({ kind: 'environment', environmentId: 'e1', action: 'stop', requestedById: 'u1' })).rejects.toThrow(/not managed for this environment/);
      expect(calls).toEqual([]); // nothing was touched
    }
    expect(audit.every((a) => a.result === 'ERROR')).toBe(true);
  });

  it('fails clearly when nothing is deployed or the container is gone', async () => {
    const none = new ContainerOps(fakePrisma({ env: ENV, dep: null }), fakeDocker({}).docker, auditor);
    await expect(none.run({ kind: 'environment', environmentId: 'e1', action: 'start', requestedById: 'u1' })).rejects.toThrow(/nothing is deployed/);
    const gone = new ContainerOps(fakePrisma({ env: ENV, dep: { containerName: 'missing' } }), fakeDocker({}).docker, auditor);
    await expect(gone.run({ kind: 'environment', environmentId: 'e1', action: 'start', requestedById: 'u1' })).rejects.toThrow(/does not exist/);
  });

  it('records a Docker failure as an audited error', async () => {
    const { docker } = fakeDocker({ c: MANAGED });
    docker.control = async () => { throw new Error('boom'); };
    const ops = new ContainerOps(fakePrisma({ env: ENV, dep: { containerName: 'c' } }), docker, auditor);
    await expect(ops.run({ kind: 'environment', environmentId: 'e1', action: 'stop', requestedById: 'u1' })).rejects.toThrow('boom');
    expect(audit[0]).toMatchObject({ action: 'container.stop', result: 'ERROR' });
  });
});

describe('ContainerOps: platform containers', () => {
  it('only exact allowlisted names are addressable: nothing else on the host, however it is spelled', async () => {
    const { docker, calls } = fakeDocker({});
    const ops = new ContainerOps(fakePrisma(), docker, auditor);
    for (const name of ['tega_rw_backend', 'aegisops-deployer', 'aegisops-api; rm -rf /', '../etc', 'aegisops-', 'AEGISOPS-GRAFANA', 'aegisops-grafana ']) {
      await expect(ops.run({ kind: 'platform', name, action: 'restart', requestedById: 'u1', reason: 'because I can' })).rejects.toThrow(/not a controllable/);
    }
    expect(calls).toEqual([]);
    expect(audit.every((a) => a.result === 'DENIED')).toBe(true);
  });

  it('the executor itself (deployer) is never controllable from the dashboard', () => {
    expect(PLATFORM_CONTAINERS as readonly string[]).not.toContain('aegisops-deployer');
  });

  it('critical services can only be RESTARTED (stopping them would cut off the dashboard); others may start/stop/restart', () => {
    for (const n of ['aegisops-postgres', 'aegisops-redis', 'aegisops-api', 'aegisops-web', 'aegisops-nginx', 'aegisops-keycloak']) {
      expect(platformActionAllowed(n, 'restart')).toEqual({ ok: true });
      expect(platformActionAllowed(n, 'stop').ok).toBe(false);
      expect(platformActionAllowed(n, 'start').ok).toBe(false);
    }
    for (const a of ['start', 'stop', 'restart'] as const) expect(platformActionAllowed('aegisops-grafana', a)).toEqual({ ok: true });
  });

  it('performs an allowed action and records the typed reason in the audit log', async () => {
    const { docker, calls } = fakeDocker({});
    await new ContainerOps(fakePrisma(), docker, auditor).run({ kind: 'platform', name: 'aegisops-grafana', action: 'restart', requestedById: 'u1', reason: 'dashboards stuck' });
    expect(calls).toEqual([{ name: 'aegisops-grafana', action: 'restart' }]);
    expect(audit[0]).toMatchObject({ action: 'platform.container.restart', result: 'SUCCESS', metadata: { reason: 'dashboards stuck' } });
  });
});

describe('ContainerOps: drain (FR-INFRA-3)', () => {
  const SERVER = { id: 's1', name: 'primary', cordoned: true };

  it('refuses to drain a server that is not cordoned (the cordon is re-checked, not trusted)', async () => {
    const { docker, calls } = fakeDocker({ a: MANAGED });
    const ops = new ContainerOps(fakePrisma({ server: { ...SERVER, cordoned: false } }), docker, auditor);
    await expect(ops.run({ kind: 'drain', serverId: 's1', requestedById: 'u1', reason: 'maintenance window' })).rejects.toThrow(/not cordoned/);
    expect(calls).toEqual([]);
    expect(audit[0]).toMatchObject({ action: 'server.drain', result: 'DENIED' });
  });

  it('stops every managed container, and ONLY managed ones, then audits who, why and what', async () => {
    const { docker, calls } = fakeDocker({ a: MANAGED, b: { ...MANAGED, 'aegisops.environment': 'production' }, 'aegisops-postgres': {}, tega: {} });
    await new ContainerOps(fakePrisma({ server: SERVER }), docker, auditor).run({ kind: 'drain', serverId: 's1', requestedById: 'u1', reason: 'kernel upgrade' });
    expect(calls).toEqual([{ name: 'a', action: 'stop' }, { name: 'b', action: 'stop' }]);
    expect(audit[0]).toMatchObject({ action: 'server.drain', result: 'SUCCESS', metadata: { reason: 'kernel upgrade', stopped: ['a', 'b'], server: 'primary' } });
  });

  it('keeps going if one container will not stop, then reports the drain as incomplete', async () => {
    const { docker, calls } = fakeDocker({ a: MANAGED, b: MANAGED });
    docker.control = async (name, action) => { calls.push({ name, action }); if (name === 'a') throw new Error('stuck'); };
    await expect(new ContainerOps(fakePrisma({ server: SERVER }), docker, auditor).run({ kind: 'drain', serverId: 's1', requestedById: 'u1', reason: 'maintenance window' })).rejects.toThrow(/incomplete/);
    expect(calls.map((c) => c.name)).toEqual(['a', 'b']);
    expect(audit[0]).toMatchObject({ result: 'ERROR', metadata: { stopped: ['b'] } });
  });
});
