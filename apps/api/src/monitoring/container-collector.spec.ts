import { ContainerCollector, type DockerLike } from './container-collector';

type C = { Id: string; Names: string[]; State: string; Labels?: Record<string, string> };
type Info = { SizeRw?: number; RestartCount?: number; HostConfig?: { Memory?: number }; State?: { Running?: boolean; Restarting?: boolean; StartedAt?: string; Health?: { Status?: string } } };

function fake(containers: C[], info: Record<string, Info | Error>, stats: Record<string, any> = {}): DockerLike {
  return {
    listContainers: async () => containers,
    getContainer: (id: string) => ({
      // Like Docker, the size is only computed when asked for.
      inspect: async (opts?: { size?: boolean }) => {
        const i = info[id];
        if (i instanceof Error) throw i;
        const { SizeRw, ...rest } = i ?? {};
        return opts?.size ? { ...rest, SizeRw } : rest;
      },
      stats: async () => stats[id] ?? {},
    }),
  };
}

const managed = (id: string, name: string, project = 'shop', environment = 'staging'): C => ({
  Id: id, Names: [`/${name}`], State: 'running', Labels: { 'aegisops.managed': 'true', 'aegisops.project': project, 'aegisops.environment': environment },
});

const find = (text: string, metric: string, labelPart: string) =>
  text.split('\n').find((l) => l.startsWith(metric + '{') && l.includes(labelPart));

describe('ContainerCollector', () => {
  const NOW = 1_800_000_000_000;

  it('labels managed containers with project and environment from the aegisops.* labels, platform ones with name only', async () => {
    const c = new ContainerCollector(
      fake([managed('a', 'aegis-shop-staging-1234'), { Id: 'b', Names: ['/aegisops-postgres'], State: 'running', Labels: { 'com.docker.compose.service': 'postgres' } }],
        { a: { State: { Running: true } }, b: { State: { Running: true } } }),
      () => NOW,
    );
    await c.refresh();
    const text = await c.metrics();
    expect(find(text, 'aegisops_container_up', 'name="aegis-shop-staging-1234"')).toContain('project="shop"');
    expect(find(text, 'aegisops_container_up', 'name="aegis-shop-staging-1234"')).toContain('environment="staging"');
    expect(find(text, 'aegisops_container_up', 'name="aegisops-postgres"')).toContain('project=""');
  });

  it('reports up / restarting / exited correctly, plus restart count and start time', async () => {
    const list: C[] = [managed('a', 'ok'), { ...managed('b', 'looping'), State: 'restarting' }, { ...managed('c', 'dead'), State: 'exited' }];
    const c = new ContainerCollector(fake(list, {
      a: { State: { Running: true, StartedAt: '2026-11-03T10:00:00.000Z' }, RestartCount: 0 },
      b: { State: { Running: false, Restarting: true }, RestartCount: 7 },
      c: { State: { Running: false }, RestartCount: 0 },
    }), () => NOW);
    await c.refresh();
    const t = await c.metrics();
    expect(find(t, 'aegisops_container_up', 'name="ok"')!.endsWith(' 1')).toBe(true);
    expect(find(t, 'aegisops_container_up', 'name="looping"')!.endsWith(' 0')).toBe(true);
    expect(find(t, 'aegisops_container_up', 'name="dead"')!.endsWith(' 0')).toBe(true);
    expect(find(t, 'aegisops_container_restarting', 'name="looping"')!.endsWith(' 1')).toBe(true);
    expect(find(t, 'aegisops_container_restarting', 'name="ok"')!.endsWith(' 0')).toBe(true);
    expect(find(t, 'aegisops_container_restart_count', 'name="looping"')!.endsWith(' 7')).toBe(true);
    expect(find(t, 'aegisops_container_started_timestamp_seconds', 'name="ok"')!.endsWith(String(Date.parse('2026-11-03T10:00:00.000Z') / 1000))).toBe(true);
  });

  it('computes CPU seconds, memory (minus reclaimable cache), network and uses OUR memory limit, not the host total', async () => {
    const c = new ContainerCollector(fake([managed('a', 'app')], {
      a: { State: { Running: true }, HostConfig: { Memory: 268435456 } },
    }, {
      a: {
        cpu_stats: { cpu_usage: { total_usage: 2_500_000_000 } },
        memory_stats: { usage: 100_000_000, stats: { inactive_file: 30_000_000 }, limit: 16_000_000_000 },
        networks: { eth0: { rx_bytes: 100, tx_bytes: 50 }, eth1: { rx_bytes: 1, tx_bytes: 2 } },
      },
    }), () => NOW);
    await c.refresh();
    const t = await c.metrics();
    expect(find(t, 'aegisops_container_cpu_seconds_total', 'name="app"')!.endsWith(' 2.5')).toBe(true);
    expect(find(t, 'aegisops_container_memory_bytes', 'name="app"')!.endsWith(' 70000000')).toBe(true);
    expect(find(t, 'aegisops_container_memory_limit_bytes', 'name="app"')!.endsWith(' 268435456')).toBe(true);
    expect(find(t, 'aegisops_container_network_receive_bytes_total', 'name="app"')!.endsWith(' 101')).toBe(true);
    expect(find(t, 'aegisops_container_network_transmit_bytes_total', 'name="app"')!.endsWith(' 52')).toBe(true);
  });

  it('exports no memory-limit series for a container without a configured limit', async () => {
    const c = new ContainerCollector(fake([managed('a', 'app')], { a: { State: { Running: true }, HostConfig: { Memory: 0 } } },
      { a: { memory_stats: { usage: 10, limit: 16_000_000_000 } } }), () => NOW);
    await c.refresh();
    expect(await c.metrics()).not.toMatch(/^aegisops_container_memory_limit_bytes\{/m);
  });

  it('exports the container\'s own disk use, measured at most every five minutes, and keeps the last value if a measurement fails', async () => {
    let now = NOW;
    const info: Record<string, Info> = { a: { State: { Running: true }, SizeRw: 5_000_000 } };
    let sizeCalls = 0;
    let failing = false;
    const docker: DockerLike = {
      listContainers: async () => [managed('a', 'app')],
      getContainer: () => ({
        inspect: async (opts?: { size?: boolean }) => {
          if (opts?.size) { sizeCalls++; if (failing) throw new Error('slow'); return info.a; }
          return { State: info.a.State };
        },
        stats: async () => ({}),
      }),
    };
    const c = new ContainerCollector(docker, () => now);
    const disk = async () => find(await c.metrics(), 'aegisops_container_disk_bytes', 'name="app"')?.split(' ').pop();

    await c.refresh();
    expect(await disk()).toBe('5000000');

    info.a.SizeRw = 9_000_000;
    now += 60_000;
    await c.refresh();
    expect(sizeCalls).toBe(1); // still fresh: not measured again
    expect(await disk()).toBe('5000000');

    now += 5 * 60_000;
    await c.refresh();
    expect(sizeCalls).toBe(2);
    expect(await disk()).toBe('9000000');

    failing = true;
    now += 6 * 60_000;
    await c.refresh();
    expect(await disk()).toBe('9000000'); // measurement failed: the previous figure stays
  });

  it('exports Docker health as a one-hot series', async () => {
    const c = new ContainerCollector(fake([managed('a', 'sick')], { a: { State: { Running: true, Health: { Status: 'unhealthy' } } } }), () => NOW);
    await c.refresh();
    const t = await c.metrics();
    expect(find(t, 'aegisops_container_health', 'status="unhealthy"')!.endsWith(' 1')).toBe(true);
    expect(find(t, 'aegisops_container_health', 'status="healthy"')!.endsWith(' 0')).toBe(true);
  });

  it('a container that disappears drops out of the next refresh (so "expected but absent" alerts can fire)', async () => {
    const list = [managed('a', 'one'), managed('b', 'two')];
    const docker = fake(list, { a: { State: { Running: true } }, b: { State: { Running: true } } });
    const c = new ContainerCollector(docker, () => NOW);
    await c.refresh();
    expect(await c.metrics()).toContain('name="two"');
    list.pop();
    await c.refresh();
    const t = await c.metrics();
    expect(t).toContain('name="one"');
    expect(t).not.toContain('name="two"');
  });

  it('one unreadable container does not break the others, and is counted', async () => {
    const c = new ContainerCollector(fake([managed('a', 'good'), managed('b', 'bad')], { a: { State: { Running: true } }, b: new Error('boom') }), () => NOW);
    await c.refresh();
    const t = await c.metrics();
    expect(t).toContain('name="good"');
    expect(t).not.toMatch(/aegisops_container_up\{[^}]*name="bad"/);
    expect(t).toMatch(/aegisops_container_exporter_errors 1/);
    expect(t).toContain(`aegisops_container_exporter_last_refresh_timestamp_seconds ${NOW / 1000}`);
  });

  it('asks Docker only for containers on the platform network, so other workloads on the host are never read', async () => {
    let seen: any;
    const docker: DockerLike = { listContainers: async (opts) => { seen = opts; return []; }, getContainer: () => ({ inspect: async () => ({}), stats: async () => ({}) }) };
    await new ContainerCollector(docker, () => NOW).refresh();
    expect(seen).toEqual({ all: true, filters: { network: ['aegisops-net'] } });
    await new ContainerCollector(docker, () => NOW, undefined, 'custom-net').refresh();
    expect(seen.filters.network).toEqual(['custom-net']);
  });

  it('never puts container environment variables or command lines into metrics (only names and the aegisops labels)', async () => {
    const c = new ContainerCollector(fake([{ ...managed('a', 'app'), Labels: { ...managed('a', 'app').Labels, 'secret.label': 'hunter2' } }], { a: { State: { Running: true } } }), () => NOW);
    await c.refresh();
    expect(await c.metrics()).not.toContain('hunter2');
  });
});
