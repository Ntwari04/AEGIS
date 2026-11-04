import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

export interface PgConn {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/** Row count per table ("schema.table" -> n), taken inside one snapshot. */
export type TableCounts = Record<string, number>;

/**
 * Real pg_dump / psql, never a re-implementation. Passwords travel only in the child's environment (never argv, never logged).
 * `prefix` lets tests run the same binaries inside a container, e.g. ['docker','exec','-i',name]; production leaves it empty.
 */
export class PgTools {
  constructor(private readonly prefix: string[] = []) {}

  private start(cmd: string, args: string[], conn: PgConn, extraEnv: Record<string, string> = {}): ChildProcessWithoutNullStreams {
    const env = { PGPASSWORD: conn.password, PGCONNECT_TIMEOUT: '10', PGAPPNAME: 'aegisops-data-worker', ...extraEnv };
    const target = ['-h', conn.host, '-p', String(conn.port), '-U', conn.user, '-d', conn.database];
    if (this.prefix.length) {
      const argv = [...this.prefix, 'env', ...Object.entries(env).map(([k, v]) => `${k}=${v}`), cmd, ...target, ...args];
      return spawn(argv[0], argv.slice(1));
    }
    return spawn(cmd, [...target, ...args], { env: { ...process.env, ...env } });
  }

  /** Resolves when the process exits 0; rejects with the tail of stderr otherwise. */
  private watch(p: ChildProcessWithoutNullStreams, what: string): Promise<void> {
    let err = '';
    p.stderr.on('data', (d) => { err = (err + d.toString()).slice(-2000); });
    return new Promise((resolve, reject) => {
      p.on('error', (e) => reject(new Error(`${what} could not start: ${e.message}`)));
      p.on('close', (code, signal) => (code === 0 ? resolve() : reject(new Error(`${what} failed (${signal ?? `exit ${code}`}): ${err.trim().slice(-500)}`))));
    });
  }

  /** One-shot SQL; returns stdout. Values are never interpolated here: callers pass fixed SQL or validated identifiers only. */
  async query(conn: PgConn, sql: string): Promise<string> {
    const p = this.start('psql', ['-X', '-At', '-v', 'ON_ERROR_STOP=1', '-c', sql], conn);
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    await this.watch(p, 'psql');
    return out;
  }

  /** Plain-format dump: streams (so it can be gzip'd, encrypted and uploaded without a temp file). `snapshot` ties it to a session's snapshot. */
  dump(conn: PgConn, opts: { snapshot?: string } = {}): { stream: Readable; done: Promise<void> } {
    const args = ['--no-owner', '--no-acl', '--format=plain', '--encoding=UTF8', ...(opts.snapshot ? [`--snapshot=${opts.snapshot}`] : [])];
    const p = this.start('pg_dump', args, conn);
    const done = this.watch(p, 'pg_dump');
    done.catch(() => undefined); // surfaced by whoever awaits it; avoid an unhandled rejection if the stream path fails first
    return { stream: p.stdout, done };
  }

  /**
   * Restore a plain dump read from stdin. ON_ERROR_STOP + a single transaction: it either all applies or nothing does.
   * `role` makes everything the dump creates owned by that role (SET ROLE via PGOPTIONS), used when restoring over a provisioned database.
   */
  restore(conn: PgConn, opts: { role?: string } = {}): { stdin: Writable; done: Promise<void> } {
    const p = this.start('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '--single-transaction', '-f', '-'], conn, opts.role ? { PGOPTIONS: `-c role=${opts.role}` } : {});
    p.stdout.resume(); // psql -q prints little; never let a full pipe stall it
    const done = this.watch(p, 'psql restore');
    done.catch(() => undefined);
    return { stdin: p.stdin, done };
  }

  /**
   * Runs a multi-statement psql script from stdin. `vars` become psql variables, written into the script (never into argv, so
   * they cannot show up in a process list) and restricted to URL-safe characters, so a value can never break out of its quotes.
   */
  async runScript(conn: PgConn, script: string, vars: Record<string, string> = {}): Promise<void> {
    for (const [k, v] of Object.entries(vars)) {
      if (!/^[a-z_][a-z0-9_]*$/.test(k) || !/^[A-Za-z0-9_-]+$/.test(v)) throw new Error('refusing an unsafe psql variable');
    }
    const p = this.start('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', '-'], conn);
    p.stdout.resume();
    const done = this.watch(p, 'psql script');
    const setVars = Object.entries(vars).map(([k, v]) => `\\set ${k} '${v}'\n`).join('');
    p.stdin.write(setVars + script + '\n');
    p.stdin.end();
    await done;
  }

  openSession(conn: PgConn): PgSession {
    return new PgSession(this.start('psql', ['-X', '-At', '-v', 'ON_ERROR_STOP=1'], conn), (p) => this.watch(p, 'psql session'));
  }

  /** Row counts for every table, in the session's current snapshot. */
  async countRows(conn: PgConn): Promise<TableCounts> {
    const out = await this.query(conn, COUNT_SQL);
    return parseCounts(out);
  }
}

/** A long-lived psql so a transaction (and its exported snapshot) stays open while pg_dump runs. */
export class PgSession {
  private buf = '';
  private waiter?: { token: string; resolve: (lines: string[]) => void; reject: (e: Error) => void };
  private seq = 0;
  private readonly exited: Promise<void>;
  private closed = false;

  constructor(private readonly p: ChildProcessWithoutNullStreams, watch: (p: ChildProcessWithoutNullStreams) => Promise<void>) {
    this.exited = watch(p);
    this.exited.catch((e) => this.waiter?.reject(e));
    p.stdout.on('data', (d) => { this.buf += d.toString(); this.pump(); });
  }

  private pump() {
    const w = this.waiter;
    if (!w) return;
    const i = this.buf.indexOf(w.token);
    if (i < 0) return;
    const lines = this.buf.slice(0, i).split('\n').map((l) => l.trim()).filter(Boolean);
    this.buf = this.buf.slice(i + w.token.length);
    this.waiter = undefined;
    w.resolve(lines);
  }

  /** Runs `sql` and returns its output lines. */
  run(sql: string): Promise<string[]> {
    const token = `__AEGIS_DONE_${++this.seq}__`;
    return new Promise((resolve, reject) => {
      this.waiter = { token, resolve, reject };
      this.p.stdin.write(`${sql.trim().replace(/;?$/, ';')}\n\\echo ${token}\n`);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.p.stdin.write('COMMIT;\n\\q\n');
    await this.exited;
  }

  /** Abandon the session (error paths): closing stdin ends psql, which rolls the transaction back. */
  kill() {
    this.closed = true;
    this.p.stdin.end();
    this.p.kill();
  }
}

export const COUNT_SQL = `
SELECT table_schema || '.' || table_name || '|' ||
       (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text
FROM information_schema.tables
WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema')
ORDER BY 1`;

export function parseCounts(lines: string | string[]): TableCounts {
  const arr = Array.isArray(lines) ? lines : lines.split('\n');
  const out: TableCounts = {};
  for (const line of arr.map((l) => l.trim()).filter(Boolean)) {
    const i = line.lastIndexOf('|');
    if (i < 0) continue;
    out[line.slice(0, i)] = Number(line.slice(i + 1));
  }
  return out;
}

/** Compares a restore against the manifest taken in the same snapshot as the dump. Exact: any difference is a failure. */
export function compareCounts(expected: TableCounts, actual: TableCounts) {
  const missing = Object.keys(expected).filter((t) => !(t in actual));
  const unexpected = Object.keys(actual).filter((t) => !(t in expected));
  const mismatched = Object.keys(expected)
    .filter((t) => t in actual && actual[t] !== expected[t])
    .map((t) => ({ table: t, expected: expected[t], actual: actual[t] }));
  return {
    ok: missing.length === 0 && unexpected.length === 0 && mismatched.length === 0,
    tables: Object.keys(expected).length,
    rows: Object.values(expected).reduce((a, b) => a + b, 0),
    missing, unexpected, mismatched,
  };
}
