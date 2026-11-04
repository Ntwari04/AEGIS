import { MonitoringClient } from './monitoring.controller';

describe('MonitoringClient.logs: the LogQL cannot be altered by its inputs', () => {
  const seen: string[] = [];
  const fetchImpl = (async (url: string) => {
    const u = new URL(url);
    seen.push(u.searchParams.get('query') ?? '');
    return { ok: true, status: 200, json: async () => ({ data: { result: [{ stream: { container: 'c1' }, values: [['1700000000000000000', 'hello'], ['1700000001000000000', 'world']] }] } }) } as any;
  }) as unknown as typeof fetch;
  const client = () => new MonitoringClient(fetchImpl);
  beforeAll(() => { process.env.LOKI_URL = 'http://loki.test:3100'; });
  beforeEach(() => { seen.length = 0; });

  it('builds exactly {project, environment} with an optional substring filter', async () => {
    await client().logs('shop', 'staging', { minutes: 30, limit: 100 });
    await client().logs('shop', 'staging', { minutes: 30, limit: 100, contains: 'error' });
    expect(seen).toEqual(['{project="shop", environment="staging"}', '{project="shop", environment="staging"} |= "error"']);
  });

  it('escapes quotes and backslashes so a value cannot close the selector or inject a pipeline stage', async () => {
    await client().logs('a"} or {job=~".+"', 'b\\', { minutes: 5, limit: 10, contains: '" |~ ".*" | line_format "x' });
    const q = seen[0];
    // every quote that came from input is escaped, so the selector still has exactly the two label matchers and one substring filter
    expect(q).toBe('{project="a\\"} or {job=~\\".+\\"", environment="b\\\\"} |= "\\" |~ \\".*\\" | line_format \\"x"');
  });

  it('rejects a search containing a newline or NUL', async () => {
    await expect(client().logs('shop', 'staging', { minutes: 5, limit: 10, contains: 'a\nb' })).rejects.toThrow(/invalid search/);
    await expect(client().logs('shop', 'staging', { minutes: 5, limit: 10, contains: 'a\0b' })).rejects.toThrow(/invalid search/);
  });

  it('returns newest first, bounded by the limit, with timestamps converted from nanoseconds', async () => {
    const lines = await client().logs('shop', 'staging', { minutes: 5, limit: 1 });
    expect(lines).toEqual([{ ts: new Date(1_700_000_001_000).toISOString(), line: 'world', container: 'c1' }]);
  });

  it('refuses to run without a configured Loki', async () => {
    const saved = process.env.LOKI_URL;
    delete process.env.LOKI_URL;
    try { await expect(client().logs('shop', 'staging', { minutes: 5, limit: 10 })).rejects.toThrow(/not configured/); } finally { process.env.LOKI_URL = saved; }
  });
});
