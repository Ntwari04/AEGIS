import { buildProjects, environmentLinks, toAlertDto, type ContainerSamples, type OverviewInput } from './overview';

const S = (name: string, value: number) => ({ metric: { name }, value });
const NOW = 1_800_000_000;

function samples(p: Partial<ContainerSamples> = {}): ContainerSamples {
  return { up: [], restarting: [], cpu: [], memory: [], memoryLimit: [], disk: [], restarts1h: [], started: [], ...p };
}

function input(over: Partial<OverviewInput> = {}): OverviewInput {
  return {
    projects: [{ id: 'p1', name: 'Shop', slug: 'shop', githubRepo: 'o/shop', environments: [{ id: 'e1', name: 'staging', isProduction: false }, { id: 'e2', name: 'production', isProduction: true }] }],
    latest: new Map(), expected: new Map(), samples: samples(), alerts: [], nowSeconds: NOW, ...over,
  };
}

describe('buildProjects: environment health', () => {
  it('up: reports CPU, memory, limit, restarts and uptime for the container that should be running', () => {
    const [p] = buildProjects(input({
      expected: new Map([['e1', 'c-1']]),
      latest: new Map([['e1', { status: 'SUCCESS', commitSha: 'abc', at: new Date('2026-11-03T10:00:00Z') }]]),
      samples: samples({ up: [S('c-1', 1)], restarting: [S('c-1', 0)], cpu: [S('c-1', 0.25)], memory: [S('c-1', 50_000_000)], memoryLimit: [S('c-1', 256_000_000)], disk: [S('c-1', 12_000_000)], restarts1h: [S('c-1', 0)], started: [S('c-1', NOW - 3600)] }),
    }));
    const e = p.environments[0];
    expect(e).toMatchObject({ state: 'up', container: 'c-1', cpuCores: 0.25, memoryBytes: 50_000_000, memoryLimitBytes: 256_000_000, diskBytes: 12_000_000, restarts1h: 0, uptimeSeconds: 3600 });
    expect(e.deployment).toMatchObject({ status: 'SUCCESS', commitSha: 'abc' });
  });

  it('down when Prometheus reports the container stopped', () => {
    const e = buildProjects(input({ expected: new Map([['e1', 'c-1']]), samples: samples({ up: [S('c-1', 0)] }) }))[0].environments[0];
    expect(e.state).toBe('down');
    expect(e.cpuCores).toBeNull(); // no resource numbers for a container that is not running
    expect(e.uptimeSeconds).toBeNull();
  });

  it('down (not silently missing) when the container has vanished from Prometheus entirely', () => {
    const e = buildProjects(input({ expected: new Map([['e1', 'c-1']]), samples: samples({ up: [S('other', 1)] }) }))[0].environments[0];
    expect(e.state).toBe('down');
  });

  it('restarting when the container is in a restart loop', () => {
    const e = buildProjects(input({ expected: new Map([['e1', 'c-1']]), samples: samples({ up: [S('c-1', 0)], restarting: [S('c-1', 1)] }) }))[0].environments[0];
    expect(e.state).toBe('restarting');
  });

  it('none when nothing has been deployed, even if monitoring is down', () => {
    expect(buildProjects(input())[0].environments.map((e) => e.state)).toEqual(['none', 'none']);
    expect(buildProjects(input({ samples: null }))[0].environments.map((e) => e.state)).toEqual(['none', 'none']);
  });

  it('unknown (never a false "up") when monitoring is unreachable', () => {
    const e = buildProjects(input({ expected: new Map([['e1', 'c-1']]), samples: null }))[0].environments[0];
    expect(e.state).toBe('unknown');
    expect(e.cpuCores).toBeNull();
  });

  it('only the container that SHOULD be running counts: an old container of the same environment is ignored', () => {
    const e = buildProjects(input({ expected: new Map([['e1', 'new']]), samples: samples({ up: [S('old', 1), S('new', 0)] }) }))[0].environments[0];
    expect(e.state).toBe('down');
  });
});

describe('buildProjects: alerts and links', () => {
  const alert = (project: string | undefined, environment: string | undefined, name = 'ContainerDown') =>
    ({ name, severity: 'critical', summary: 's', since: 'x', ...(project ? { project } : {}), ...(environment ? { environment } : {}) });

  it('attaches an alert to exactly its project/environment and counts them', () => {
    const [p] = buildProjects(input({ alerts: [alert('shop', 'staging'), alert('shop', 'staging', 'X'), alert('shop', 'production'), alert('other', 'staging')] }));
    expect(p.environments[0].alerts).toHaveLength(2);
    expect(p.environments[1].alerts).toHaveLength(1);
    expect(p.openAlerts).toBe(3);
  });

  it('platform-level alerts (no project) are not attached to any project', () => {
    const [p] = buildProjects(input({ alerts: [alert(undefined, undefined, 'HostMemoryHigh')] }));
    expect(p.openAlerts).toBe(0);
  });

  it('links (FR-DASH-4) are present only when a Grafana URL is given, and point at that project and environment', () => {
    const none = buildProjects(input())[0].environments[0];
    expect(none.links).toBeUndefined();
    const withLinks = buildProjects(input({ grafana: 'https://grafana.example.com/' }))[0].environments[1];
    expect(withLinks.links!.dashboard).toBe('https://grafana.example.com/d/aegisops-env?var-project=shop&var-environment=production');
    expect(withLinks.links!.logs).toContain('https://grafana.example.com/explore?');
  });

  it('the Loki log query is exactly {project, environment} and cannot be broken out of with quotes', () => {
    const url = new URL(environmentLinks('https://g.example.com', 'shop', 'staging').logs);
    const pane = JSON.parse(url.searchParams.get('panes')!);
    expect(pane.a.queries[0].expr).toBe('{project="shop", environment="staging"}');
    const nasty = new URL(environmentLinks('https://g.example.com', 'a"} |= "x', 'b\\').logs);
    const expr = JSON.parse(nasty.searchParams.get('panes')!).a.queries[0].expr as string;
    expect(expr).toBe('{project="a\\"} |= \\"x", environment="b\\\\"}');
  });
});

describe('toAlertDto', () => {
  it('keeps only what the dashboard shows (no generator URLs, fingerprints or arbitrary labels)', () => {
    const dto = toAlertDto({ labels: { alertname: 'ContainerDown', severity: 'critical', project: 'shop', environment: 'staging', name: 'c1', internal: 'secret' }, annotations: { summary: 'Container c1 is down', runbook: 'x' }, startsAt: '2026-11-03T10:00:00Z' } as any);
    expect(dto).toEqual({ name: 'ContainerDown', severity: 'critical', summary: 'Container c1 is down', since: '2026-11-03T10:00:00Z', project: 'shop', environment: 'staging' });
    expect(JSON.stringify(dto)).not.toContain('secret');
  });
  it('tolerates a sparse alert', () => {
    expect(toAlertDto({})).toMatchObject({ name: 'unknown', severity: 'warning' });
  });
});
