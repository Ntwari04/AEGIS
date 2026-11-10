import { parseCursor, streamLogs, toSse, type StreamEvent, type TailLine, type TailSource } from './log-stream';

// Nanosecond timestamps do not fit a JavaScript number exactly, so every one here is a BigInt offset from this base.
const T = 1_000_000_000_000_000_000n;

/** A fake Loki: a growing log, `start` INCLUSIVE like the real one, and failures on demand. */
function fakeLoki() {
  const log: TailLine[] = [];
  const state = { failNext: 0, calls: [] as { since: bigint; contains?: string }[] };
  const src: TailSource = {
    async tail(_p, _e, since, opts) {
      state.calls.push({ since, contains: opts.contains });
      if (state.failNext > 0) { state.failNext--; throw new Error('loki is down'); }
      return log.filter((l) => BigInt(l.ns) >= since && (!opts.contains || l.line.includes(opts.contains))).slice(0, opts.limit);
    },
  };
  const add = (offset: number, line: string) => log.push({ ns: String(T + BigInt(offset)), line, container: 'c1' });
  return { src, add, state };
}

const base = { pollMs: 5, heartbeatMs: 10_000, maxMs: 10_000 };
async function collect(gen: AsyncGenerator<StreamEvent>, until: (e: StreamEvent[]) => boolean, ctl: AbortController, timeoutMs = 2000) {
  const out: StreamEvent[] = [];
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    for await (const e of gen) { out.push(e); if (until(out)) break; }
  } finally { clearTimeout(timer); ctl.abort(); }
  return out;
}
const lines = (e: StreamEvent[]) => e.filter((x): x is Extract<StreamEvent, { type: 'line' }> => x.type === 'line').map((x) => x.line);

describe('streamLogs', () => {
  it('sends each line once, in order, including lines that arrive later', async () => {
    const { src, add } = fakeLoki();
    add(1, 'one'); add(2, 'two');
    const ctl = new AbortController();
    setTimeout(() => add(3, 'three'), 30);
    const out = await collect(streamLogs(src, 'p', 'e', { ...base, sinceNs: T, signal: ctl.signal }), (e) => lines(e).length === 3, ctl);
    expect(lines(out)).toEqual(['one', 'two', 'three']);
  });

  it('never repeats a line when the next poll starts at the same instant (the start is inclusive)', async () => {
    const { src, add, state } = fakeLoki();
    add(1, 'only');
    const ctl = new AbortController();
    const out = await collect(streamLogs(src, 'p', 'e', { ...base, sinceNs: 1n, signal: ctl.signal }), () => state.calls.length >= 5, ctl);
    expect(lines(out)).toEqual(['only']);
    expect(state.calls.length).toBeGreaterThanOrEqual(5); // it kept polling, and kept getting that line back
  });

  it('keeps two different lines that share one nanosecond, and a third that arrives later at that same instant', async () => {
    const { src, add } = fakeLoki();
    add(5, 'a'); add(5, 'b');
    const ctl = new AbortController();
    setTimeout(() => add(5, 'c'), 30);
    const out = await collect(streamLogs(src, 'p', 'e', { ...base, sinceNs: 1n, signal: ctl.signal }), (e) => lines(e).length === 3, ctl);
    expect(lines(out).sort()).toEqual(['a', 'b', 'c']);
  });

  it('starts at the cursor: older lines are not sent, and the ids are the cursor a reconnecting browser resumes from', async () => {
    const { src, add } = fakeLoki();
    add(1, 'old'); add(9, 'new');
    const ctl = new AbortController();
    const out = await collect(streamLogs(src, 'p', 'e', { ...base, sinceNs: T + 5n, signal: ctl.signal }), (e) => lines(e).length === 1, ctl);
    expect(out[0]).toMatchObject({ type: 'line', line: 'new', id: String(T + 9n) });
  });

  it('passes the search text to the source', async () => {
    const { src, add, state } = fakeLoki();
    add(1, 'ok'); add(2, 'an error here');
    const ctl = new AbortController();
    const out = await collect(streamLogs(src, 'p', 'e', { ...base, sinceNs: 1n, contains: 'error', signal: ctl.signal }), (e) => lines(e).length === 1, ctl);
    expect(lines(out)).toEqual(['an error here']);
    expect(state.calls[0].contains).toBe('error');
  });

  it('sends a heartbeat when nothing happens, so proxies keep the connection open', async () => {
    const { src } = fakeLoki();
    const ctl = new AbortController();
    const out = await collect(streamLogs(src, 'p', 'e', { ...base, heartbeatMs: 20, sinceNs: 1n, signal: ctl.signal }), (e) => e.some((x) => x.type === 'heartbeat'), ctl);
    expect(out.some((x) => x.type === 'heartbeat')).toBe(true);
  });

  it('ends after its maximum time and says why', async () => {
    const { src } = fakeLoki();
    const ctl = new AbortController();
    const out = await collect(streamLogs(src, 'p', 'e', { ...base, maxMs: 40, sinceNs: 1n, signal: ctl.signal }), () => false, ctl);
    expect(out[out.length - 1]).toMatchObject({ type: 'end', reason: expect.stringMatching(/maximum time/) });
  });

  it('stops at once when the client goes away', async () => {
    const { src } = fakeLoki();
    const ctl = new AbortController();
    const started = Date.now();
    const gen = streamLogs(src, 'p', 'e', { ...base, pollMs: 5_000, sinceNs: 1n, signal: ctl.signal });
    setTimeout(() => ctl.abort(), 30);
    for await (const _ of gen) { /* nothing to send */ }
    expect(Date.now() - started).toBeLessThan(1000); // it did not sit out the 5 s poll interval
  });

  it('survives a failed poll: says so once, carries on, and says when it recovered', async () => {
    const { src, add, state } = fakeLoki();
    state.failNext = 2;
    add(1, 'after');
    const ctl = new AbortController();
    const out = await collect(streamLogs(src, 'p', 'e', { ...base, sinceNs: 1n, signal: ctl.signal }), (e) => lines(e).length === 1, ctl);
    const notices = out.filter((x) => x.type === 'notice').map((x) => (x as { message: string }).message);
    expect(notices).toEqual(['Log search is unavailable right now; retrying.', 'Log search recovered.']);
    expect(lines(out)).toEqual(['after']);
  });

  it('gives up after repeated failures instead of polling a dead Loki forever', async () => {
    const { src, state } = fakeLoki();
    state.failNext = 1_000;
    const ctl = new AbortController();
    const out = await collect(streamLogs(src, 'p', 'e', { ...base, maxFailures: 3, sinceNs: 1n, signal: ctl.signal }), () => false, ctl);
    expect(out[out.length - 1]).toMatchObject({ type: 'end', reason: expect.stringMatching(/unavailable/) });
    expect(state.calls).toHaveLength(3);
  });
});

describe('toSse and parseCursor', () => {
  it('writes standard server-sent events, with the cursor as the id', () => {
    expect(toSse({ type: 'line', id: '123', ts: '2026-11-10T10:00:00.000Z', line: 'hi\nthere', container: 'c' }))
      .toBe('event: line\nid: 123\ndata: {"ts":"2026-11-10T10:00:00.000Z","line":"hi\\nthere","container":"c"}\n\n'); // a newline inside a line cannot break the framing
    expect(toSse({ type: 'heartbeat' })).toBe(': heartbeat\n\n');
    expect(toSse({ type: 'end', reason: 'done' })).toBe('event: end\ndata: {"reason":"done"}\n\n');
  });

  it('accepts only a plausible nanosecond cursor, never a future one', () => {
    const now = Date.parse('2026-11-10T10:00:00Z');
    expect(parseCursor('1793959200000000000', now)).toBe(1793959200000000000n);
    for (const bad of ['', 'abc', '12', '1793959200000000000; DROP', '-1793959200000000000', undefined, 5, '99999999999999999999']) expect(parseCursor(bad, now)).toBeNull();
    expect(parseCursor(String((now + 3_600_000) * 1_000_000), now)).toBeNull(); // an hour ahead
  });
});
