import { MonitoringClient } from './monitoring.controller';

describe('MonitoringClient queries', () => {
  const seen: string[] = [];
  const fetchImpl = (async (url: string) => {
    seen.push(decodeURIComponent(new URL(url).searchParams.get('query') ?? ''));
    return { ok: true, status: 200, json: async () => ({ status: 'success', data: { result: [] } }) } as any;
  }) as unknown as typeof fetch;

  beforeAll(() => { process.env.PROMETHEUS_URL = 'http://prometheus.test:9090'; });

  it('sends only well-formed, fixed PromQL: no unsubstituted placeholders, balanced brackets', async () => {
    const client = new MonitoringClient(fetchImpl);
    await client.containerSamples();
    await client.platformSummary();
    expect(seen.length).toBeGreaterThanOrEqual(11);
    for (const q of seen) {
      expect(q).not.toMatch(/\$\{/);
      for (const [o, c] of [['(', ')'], ['{', '}'], ['[', ']']]) expect(q.split(o).length).toBe(q.split(c).length);
    }
  });

  it('the disk query measures the largest real filesystem (not a hard-coded / mount)', () => {
    const disk = seen.find((q) => q.includes('node_filesystem'))!;
    expect(disk).toContain('fstype=~"ext4|xfs|btrfs|zfs"');
    expect(disk).not.toContain('mountpoint="/"');
    expect(disk).toContain('scalar(max(');
  });
});
