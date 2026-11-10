/**
 * The live log stream (FR-INFRA-2) as a plain async sequence of events, with no HTTP in it, so every rule is unit-tested.
 * It polls Loki from a cursor instead of holding a connection open to it: a restart of Loki, a slow query or a dropped
 * connection costs one missed poll, not the stream.
 */
export interface TailLine { ns: string; line: string; container: string }
export interface TailSource {
  tail(project: string, environment: string, sinceNs: bigint, opts: { limit: number; contains?: string }): Promise<TailLine[]>;
}

export type StreamEvent =
  | { type: 'line'; id: string; ts: string; line: string; container: string }
  | { type: 'heartbeat' }
  | { type: 'notice'; message: string }
  | { type: 'end'; reason: string };

export interface StreamOptions {
  /** Where to start (nanoseconds since the epoch). Lines AT this instant are included, so a resume never loses one. */
  sinceNs: bigint;
  contains?: string;
  pollMs: number;
  heartbeatMs: number;
  /** The longest one stream lives; the client reconnects and resumes from its last id. */
  maxMs: number;
  /** Consecutive failed polls before giving up. */
  maxFailures?: number;
  batch?: number;
  signal: AbortSignal;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); signal.removeEventListener('abort', done); resolve(); }
    signal.addEventListener('abort', done, { once: true });
  });

export async function* streamLogs(src: TailSource, project: string, environment: string, o: StreamOptions): AsyncGenerator<StreamEvent> {
  const started = Date.now();
  let cursor = o.sinceNs;
  let seenAtCursor = new Set<string>(); // lines already sent that sit exactly AT the cursor (Loki's start is inclusive)
  let quietSince = Date.now();
  let failures = 0;
  const maxFailures = o.maxFailures ?? 5;

  while (!o.signal.aborted) {
    if (Date.now() - started >= o.maxMs) { yield { type: 'end', reason: 'This live view ran its maximum time; it reconnects on its own.' }; return; }
    try {
      const batch = await src.tail(project, environment, cursor, { limit: o.batch ?? 500, contains: o.contains });
      if (failures > 0) yield { type: 'notice', message: 'Log search recovered.' };
      failures = 0;
      for (const l of batch) {
        const ns = BigInt(l.ns);
        if (ns < cursor) continue;
        if (ns === cursor && seenAtCursor.has(l.line)) continue;
        if (ns > cursor) { cursor = ns; seenAtCursor = new Set(); }
        seenAtCursor.add(l.line);
        quietSince = Date.now();
        yield { type: 'line', id: l.ns, ts: new Date(Number(ns / 1_000_000n)).toISOString(), line: l.line, container: l.container };
      }
    } catch {
      failures++;
      if (failures >= (maxFailures)) { yield { type: 'end', reason: 'Log search stayed unavailable; stopped.' }; return; }
      if (failures === 1) yield { type: 'notice', message: 'Log search is unavailable right now; retrying.' };
    }
    if (Date.now() - quietSince >= o.heartbeatMs) { quietSince = Date.now(); yield { type: 'heartbeat' }; }
    await sleep(o.pollMs, o.signal);
  }
}

/** The wire format: standard server-sent events. `id` carries the cursor, so a reconnecting browser resumes by itself. */
export function toSse(e: StreamEvent): string {
  switch (e.type) {
    case 'line': return `event: line\nid: ${e.id}\ndata: ${JSON.stringify({ ts: e.ts, line: e.line, container: e.container })}\n\n`;
    case 'heartbeat': return ': heartbeat\n\n';
    case 'notice': return `event: notice\ndata: ${JSON.stringify({ message: e.message })}\n\n`;
    case 'end': return `event: end\ndata: ${JSON.stringify({ reason: e.reason })}\n\n`;
  }
}

/** A cursor from a client (Last-Event-ID or ?since=): digits only, a plausible nanosecond timestamp, never in the future. */
export function parseCursor(v: unknown, nowMs = Date.now()): bigint | null {
  if (typeof v !== 'string' || !/^\d{16,20}$/.test(v)) return null;
  const ns = BigInt(v);
  return ns <= BigInt(nowMs + 60_000) * 1_000_000n ? ns : null;
}
