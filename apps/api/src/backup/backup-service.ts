import { createHash, randomBytes } from 'node:crypto';
import { PassThrough, Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import type { PrismaClient } from '@prisma/client';
import { decryptStream, encryptStream } from './crypto-stream';
import type { ObjectStore } from './object-store';
import { COUNT_SQL, compareCounts, parseCounts, type PgConn, type PgTools, type TableCounts } from './pg-tools';
import { DEFAULT_RETENTION, selectPrune, type RetentionPolicy } from './retention';

export type SystemTarget = 'aegisops' | 'keycloak';
export type Target = { kind: 'system'; name: SystemTarget } | { kind: 'db'; id: string };

export const targetKey = (t: Target) => (t.kind === 'system' ? `system:${t.name}` : `db:${t.id}`);

export function parseTarget(s: string): Target {
  if (s === 'system:aegisops' || s === 'system:keycloak') return { kind: 'system', name: s.slice(7) as SystemTarget };
  const m = /^db:([0-9a-f-]{36})$/.exec(s);
  if (m) return { kind: 'db', id: m[1] };
  throw new Error('unknown backup target');
}

export interface BackupConfig {
  host: string;
  port: number;
  /** aegis_backup: reads every database (pg_read_all_data) and may CREATE scratch databases. It is not a superuser. */
  user: string;
  password: string;
  /** aegis_provisioner: used to restore a provisioned database as its own owner and for the confirmed overwrite swap. */
  provisioner?: { user: string; password: string };
  /** The real PostgreSQL names of the system databases. */
  systemDatabases: Record<SystemTarget, string>;
  encryptionKey: Buffer;
  /** Restore time objective (PRD 7): a drill slower than this is reported as outside the RTO. Default 4 h. */
  rtoSeconds: number;
  /** Waits between attempts when a scheduled backup or drill fails on a network error (default 30 s, then 2 min). */
  retryDelaysMs?: number[];
  keyPrefix: string;
  retention?: RetentionPolicy;
  /** How long a MANUAL backup is kept before it expires (default 30 days). */
  manualRetentionDays?: number;
  /** After a database is removed, its backups are kept this long (default 90 days) and then ALL expire, including the last one. */
  decommissionRetentionDays?: number;
}

export interface AuditLike {
  record(e: { actorId?: string; actorName?: string; action: string; targetType?: string; targetId?: string; result: 'SUCCESS' | 'DENIED' | 'ERROR'; metadata?: Record<string, unknown> }): Promise<void>;
}

const IDENT = /^[a-z0-9_]{1,63}$/;
const quoteIdent = (name: string) => {
  if (!IDENT.test(name)) throw new Error('refusing an unsafe database name');
  return `"${name}"`;
};
const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 500);

/** The network, not the backup, failed: DNS not yet back after the machine woke, a dropped connection, a storage hiccup. */
const TRANSIENT = /ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up|fetch failed|getaddrinfo|network|timeout/i;

function tap(onChunk: (c: Buffer) => void) {
  return new Transform({ transform(chunk, _e, cb) { onChunk(chunk); cb(null, chunk); } });
}

export class BackupService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly store: ObjectStore,
    private readonly pg: PgTools,
    private readonly cfg: BackupConfig,
    private readonly audit?: AuditLike,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private conn(database: string): PgConn {
    return { host: this.cfg.host, port: this.cfg.port, user: this.cfg.user, password: this.cfg.password, database };
  }

  private async databaseOf(t: Target): Promise<{ pgName: string; databaseId: string | null }> {
    if (t.kind === 'system') return { pgName: this.cfg.systemDatabases[t.name], databaseId: null };
    const db = await this.prisma.database.findUnique({ where: { id: t.id } });
    if (!db) throw new Error('database not found');
    return { pgName: db.pgName, databaseId: db.id };
  }

  /** Every target that gets a nightly backup (FR-BACKUP-1): the two system databases and every provisioned database. */
  async allTargets(): Promise<Target[]> {
    // A database being removed, or removed already, no longer exists to back up (its last backup was taken by the removal itself).
    const dbs = await this.prisma.database.findMany({ where: { status: { notIn: ['DECOMMISSIONING', 'DECOMMISSIONED'] } }, select: { id: true }, orderBy: { createdAt: 'asc' } });
    return [{ kind: 'system', name: 'aegisops' }, { kind: 'system', name: 'keycloak' }, ...dbs.map((d) => ({ kind: 'db' as const, id: d.id }))];
  }

  // ------------------------------------------------------------------------------------------------ backup

  async backup(target: Target, opts: { kind?: 'SCHEDULED' | 'MANUAL'; triggeredById?: string } = {}) {
    const { pgName, databaseId } = await this.databaseOf(target);
    const tkey = targetKey(target);
    const started = this.now();
    const job = await this.prisma.backupJob.create({
      data: { target: tkey, databaseId, kind: opts.kind ?? 'SCHEDULED', status: 'RUNNING', triggeredById: opts.triggeredById, startedAt: started },
    });
    const d = started;
    const objectKey = `${this.cfg.keyPrefix}${tkey.replace(':', '/')}/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${stamp(d)}-${job.id.slice(0, 8)}.sql.gz.enc`;
    const conn = this.conn(pgName);
    const session = this.pg.openSession(conn);
    try {
      // One REPEATABLE READ snapshot is shared by the row counts and pg_dump, so the manifest describes EXACTLY what was dumped.
      await session.run('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const [snapshot] = await session.run('SELECT pg_export_snapshot()');
      if (!snapshot) throw new Error('could not export a snapshot');
      const manifest = parseCounts(await session.run(COUNT_SQL));

      const dump = this.pg.dump(conn, { snapshot });
      const hash = createHash('sha256');
      let plain = 0;
      let stored = 0;
      const body = new PassThrough();
      const upload = this.store.put(objectKey, body);
      upload.catch(() => undefined);
      await Promise.all([
        pipeline(dump.stream, tap((c) => (plain += c.length)), createGzip(), encryptStream(this.cfg.encryptionKey), tap((c) => { hash.update(c); stored += c.length; }), body),
        upload,
      ]);
      await dump.done; // pg_dump exiting non-zero means a PARTIAL dump: never record it as a backup
      await session.close();

      const actual = await this.store.size(objectKey);
      if (actual !== stored) throw new Error(`stored object size ${actual} does not match the ${stored} bytes sent`);

      const done = await this.prisma.backupJob.update({
        where: { id: job.id },
        data: { status: 'SUCCESS', sizeBytes: BigInt(stored), plainBytes: BigInt(plain), sha256: hash.digest('hex'), objectKey, manifest: manifest as object, finishedAt: this.now() },
      });
      await this.audit?.record({ actorId: opts.triggeredById, actorName: opts.triggeredById ? undefined : 'scheduler', action: 'backup.finish', targetType: 'backup', targetId: job.id, result: 'SUCCESS', metadata: { target: tkey, kind: opts.kind ?? 'SCHEDULED', bytes: stored } });
      return done;
    } catch (e) {
      session.kill();
      await this.store.delete(objectKey).catch(() => undefined); // a failed backup leaves no partial object behind
      const failed = await this.prisma.backupJob.update({ where: { id: job.id }, data: { status: 'FAILED', error: errText(e), finishedAt: this.now() } });
      await this.audit?.record({ actorId: opts.triggeredById, actorName: opts.triggeredById ? undefined : 'scheduler', action: 'backup.finish', targetType: 'backup', targetId: job.id, result: 'ERROR', metadata: { target: tkey, error: errText(e) } });
      return failed;
    }
  }

  /** Nightly run (FR-BACKUP-1). One target failing never stops the others; the result of each is its BackupJob row. */
  /**
   * Runs `attempt` again, after a pause, when it failed only because of the network. A failure that is not about the network
   * (a bad checksum, a row-count mismatch, a wrong key) is returned at once: retrying would only hide it. Every attempt keeps its own
   * history row, so nothing is concealed; only the LAST outcome drives the alert.
   */
  private async retryingOnNetworkErrors<T extends { status: string; error?: string | null }>(attempt: () => Promise<T>): Promise<T> {
    let result = await attempt();
    for (const delay of this.cfg.retryDelaysMs ?? [30_000, 120_000]) {
      if (result.status !== 'FAILED' || !TRANSIENT.test(result.error ?? '')) break;
      await new Promise((r) => setTimeout(r, delay));
      result = await attempt();
    }
    return result;
  }

  async backupAll(kind: 'SCHEDULED' | 'MANUAL' = 'SCHEDULED') {
    const results = [];
    for (const t of await this.allTargets()) results.push(await this.retryingOnNetworkErrors(() => this.backup(t, { kind })));
    return results;
  }

  // ------------------------------------------------------------------------------------------------ restore

  /** Streams the stored archive and checks it against the checksum recorded at backup time (catches replacement and corruption). */
  private async verifyChecksum(objectKey: string, expected: string) {
    // Say what is wrong in plain words: after a change of storage location the records outlive their files.
    if ((await this.store.size(objectKey)) === null) {
      throw new Error('the backup file is missing from object storage (the storage location was changed, or the file was deleted)');
    }
    const hash = createHash('sha256');
    for await (const chunk of await this.store.get(objectKey)) hash.update(chunk as Buffer);
    if (hash.digest('hex') !== expected) throw new Error('archive does not match the checksum recorded at backup time (replaced or corrupted)');
  }

  /**
   * Restore into a NEW database (FR-DB-4: never destructive). Verifies the checksum BEFORE executing anything, authenticates every
   * chunk while decrypting, applies the dump in a single transaction, then compares exact row counts against the manifest.
   * A DRILL restores to a scratch database and drops it afterwards (FR-BACKUP-4).
   */
  async restoreToNew(backupJobId: string, opts: { kind?: 'RESTORE' | 'DRILL' | 'OVERWRITE'; requestedById?: string; reason?: string; targetName?: string } = {}) {
    const kind = opts.kind ?? 'RESTORE';
    const backup = await this.prisma.backupJob.findUniqueOrThrow({ where: { id: backupJobId } });
    if (backup.status !== 'SUCCESS' || backup.deletedAt || !backup.objectKey || !backup.sha256) throw new Error('that backup is not restorable');

    const slug = backup.target.replace(/[^a-z0-9]+/gi, '_').toLowerCase().slice(0, 30);
    const name = kind === 'DRILL'
      ? `drill_${randomBytes(4).toString('hex')}`
      : opts.targetName ?? `restore_${slug}_${stamp(this.now()).replace(/[^0-9]/g, '').slice(0, 14)}`;
    if (!/^(restore|drill)_[a-z0-9_]{1,50}$/.test(name)) throw new Error('restore target must be a new database named restore_<...>');

    const rj = await this.prisma.restoreJob.create({
      data: { backupJobId, kind, status: 'RUNNING', targetDatabase: name, requestedById: opts.requestedById, reason: opts.reason },
    });
    const t0 = Date.now();
    let created = false;
    // Restoring a provisioned database: create it OWNED BY that database's own role and apply the dump as that role, so the
    // application can actually use the restored copy. Drills and system targets use the backup role (nothing needs to log in to them).
    // A database that was removed has no role any more: its backup restores under the backup role instead (data intact, no application login).
    const ownerRow = backup.databaseId && kind !== 'DRILL' && this.cfg.provisioner
      ? await this.prisma.database.findUnique({ where: { id: backup.databaseId } })
      : null;
    const owner = ownerRow && ownerRow.status !== 'DECOMMISSIONED' ? ownerRow : null;
    const adminConn: PgConn = owner
      ? { host: this.cfg.host, port: this.cfg.port, user: this.cfg.provisioner!.user, password: this.cfg.provisioner!.password, database: 'postgres' }
      : this.conn('postgres');
    try {
      await this.verifyChecksum(backup.objectKey, backup.sha256);
      await this.pg.query(adminConn, `CREATE DATABASE ${quoteIdent(name)}${owner ? ` OWNER ${quoteIdent(owner.roleName)}` : ''}`);
      created = true;

      const restore = owner
        ? this.pg.restore({ ...adminConn, database: name }, { role: owner.roleName })
        : this.pg.restore(this.conn(name));
      await Promise.all([
        pipeline(await this.store.get(backup.objectKey), decryptStream(this.cfg.encryptionKey), createGunzip(), restore.stdin),
        restore.done,
      ]);

      const actual: TableCounts = await this.pg.countRows(this.conn(name));
      const cmp = compareCounts((backup.manifest ?? {}) as TableCounts, actual);
      const durationMs = Date.now() - t0;
      const integrity = { ...cmp, checksumVerified: true, authenticated: true, withinRto: durationMs / 1000 <= this.cfg.rtoSeconds, rtoSeconds: this.cfg.rtoSeconds };
      if (!cmp.ok) throw Object.assign(new Error('integrity check failed: the restored data does not match the backup manifest'), { integrity });

      const done = await this.prisma.restoreJob.update({ where: { id: rj.id }, data: { status: 'SUCCESS', finishedAt: this.now(), durationMs, integrity: integrity as object } });
      await this.audit?.record({ actorId: opts.requestedById, actorName: opts.requestedById ? undefined : 'scheduler', action: kind === 'DRILL' ? 'backup.drill' : 'backup.restore', targetType: 'restore', targetId: rj.id, result: 'SUCCESS', metadata: { target: backup.target, into: name, durationMs, tables: cmp.tables, rows: cmp.rows } });
      return done;
    } catch (e) {
      const integrity = (e as { integrity?: object }).integrity;
      const failed = await this.prisma.restoreJob.update({ where: { id: rj.id }, data: { status: 'FAILED', finishedAt: this.now(), durationMs: Date.now() - t0, error: errText(e), integrity: integrity ?? undefined } });
      await this.audit?.record({ actorId: opts.requestedById, actorName: opts.requestedById ? undefined : 'scheduler', action: kind === 'DRILL' ? 'backup.drill' : 'backup.restore', targetType: 'restore', targetId: rj.id, result: 'ERROR', metadata: { target: backup.target, error: errText(e) } });
      return failed;
    } finally {
      // A drill never leaves its scratch database behind; a failed restore never leaves a half-restored one.
      const keep = kind !== 'DRILL' && (await this.prisma.restoreJob.findUnique({ where: { id: rj.id } }))?.status === 'SUCCESS';
      if (created && !keep) await this.pg.query(adminConn, `DROP DATABASE IF EXISTS ${quoteIdent(name)}`).catch(() => undefined);
    }
  }

  /**
   * FR-DB-4: overwrite a LIVE provisioned database with a backup. Never in place, never without a safety net:
   *   1. a fresh backup of the CURRENT state is taken first, and the overwrite is refused if that fails;
   *   2. the chosen backup is restored into a NEW database and fully verified (checksum, authentication, exact row counts);
   *   3. only then are the two swapped by renaming. The previous database is kept as `<name>_old_<time>` until a human drops it.
   * Callers must already have enforced the separate confirmation and authorisation (platform_admin, typed name, reason).
   */
  async overwrite(backupJobId: string, opts: { requestedById: string; reason: string }) {
    const backup = await this.prisma.backupJob.findUniqueOrThrow({ where: { id: backupJobId } });
    if (!backup.databaseId || !this.cfg.provisioner) throw new Error('only a provisioned database can be overwritten');
    const db = await this.prisma.database.findUniqueOrThrow({ where: { id: backup.databaseId } });
    if (db.status !== 'READY') throw new Error('that database is not ready');

    const fail = (error: string) => this.prisma.restoreJob.create({
      data: { backupJobId, kind: 'OVERWRITE', status: 'FAILED', targetDatabase: db.pgName, requestedById: opts.requestedById, reason: opts.reason, error, finishedAt: this.now() },
    });

    const safety = await this.backup({ kind: 'db', id: db.id }, { kind: 'MANUAL', triggeredById: opts.requestedById });
    if (safety.status !== 'SUCCESS') return fail(`refused: the safety backup of the current state failed (${safety.error ?? 'unknown error'}); nothing was changed`);

    const staging = `restore_ow_${randomBytes(4).toString('hex')}`;
    const staged = await this.restoreToNew(backupJobId, { kind: 'OVERWRITE', requestedById: opts.requestedById, reason: opts.reason, targetName: staging });
    if (staged.status !== 'SUCCESS') return staged; // the staging database was already dropped; the live one was never touched

    const admin: PgConn = { host: this.cfg.host, port: this.cfg.port, user: this.cfg.provisioner.user, password: this.cfg.provisioner.password, database: 'postgres' };
    const previous = `${db.pgName}_old_${stamp(this.now()).replace(/[^0-9]/g, '').slice(0, 14)}`;
    quoteIdent(previous); // validates length and characters
    try {
      await this.pg.runScript(admin, SWAP_SQL, { db: db.pgName, old: previous, staging, backup: this.cfg.user });
      const done = await this.prisma.restoreJob.update({
        where: { id: staged.id },
        data: { integrity: { ...(staged.integrity as object), safetyBackupId: safety.id, previousDatabase: previous, swapped: true } },
      });
      await this.audit?.record({ actorId: opts.requestedById, action: 'backup.overwrite', targetType: 'database', targetId: db.id, result: 'SUCCESS', metadata: { backupJobId, reason: opts.reason, safetyBackupId: safety.id, previousDatabase: previous } });
      return done;
    } catch (e) {
      // The swap did not complete: put connections back, drop the staged copy, keep the live database exactly as it was.
      await this.pg.query(admin, `ALTER DATABASE ${quoteIdent(db.pgName)} WITH ALLOW_CONNECTIONS true`).catch(() => undefined);
      await this.pg.query(admin, `DROP DATABASE IF EXISTS ${quoteIdent(staging)}`).catch(() => undefined);
      const failed = await this.prisma.restoreJob.update({ where: { id: staged.id }, data: { status: 'FAILED', error: `swap failed: ${errText(e)}`, finishedAt: this.now() } });
      await this.audit?.record({ actorId: opts.requestedById, action: 'backup.overwrite', targetType: 'database', targetId: db.id, result: 'ERROR', metadata: { backupJobId, error: errText(e) } });
      return failed;
    }
  }

  /** Weekly proof that backups restore (FR-BACKUP-4): restore the latest backup of every target to a scratch database and verify it. */
  async drill() {
    await this.cleanupScratch();
    const results = [];
    for (const t of await this.allTargets()) {
      const latest = await this.prisma.backupJob.findFirst({
        where: { target: targetKey(t), status: 'SUCCESS', deletedAt: null }, orderBy: { startedAt: 'desc' },
      });
      if (latest) results.push(await this.retryingOnNetworkErrors(() => this.restoreToNew(latest.id, { kind: 'DRILL' })));
    }
    return results;
  }

  /** Drops scratch databases left by a crashed worker. Only names this service generates (drill_<hex>) are touched. */
  async cleanupScratch() {
    const out = await this.pg.query(this.conn('postgres'), `SELECT datname FROM pg_database WHERE datname ~ '^drill_[0-9a-f]{8}$'`);
    for (const n of out.split('\n').map((s) => s.trim()).filter(Boolean)) {
      await this.pg.query(this.conn('postgres'), `DROP DATABASE IF EXISTS ${quoteIdent(n)}`).catch(() => undefined);
    }
  }

  // ------------------------------------------------------------------------------------------------ retention

  /**
   * FR-BACKUP-3: delete archives outside the retention policy. Rows stay as history (deletedAt).
   * The 14 daily / 8 weekly / 12 monthly policy applies to SCHEDULED backups. A MANUAL backup (someone took it on purpose, often
   * right before a risky change) is never displaced by a nightly one: it is kept for manualRetentionDays (default 30) and then expires.
   */
  async prune() {
    const policy = this.cfg.retention ?? DEFAULT_RETENTION;
    const manualMs = (this.cfg.manualRetentionDays ?? 30) * 86_400_000;
    let deleted = 0;
    const expire = async (row: { id: string; objectKey: string | null }) => {
      if (row.objectKey) await this.store.delete(row.objectKey);
      await this.prisma.backupJob.update({ where: { id: row.id }, data: { deletedAt: this.now() } });
      deleted++;
    };
    // A removed database's backups outlive the removal by a fixed period (a way back from a mistake), then ALL of them expire,
    // the newest included: removing data has to end somewhere.
    const goneMs = (this.cfg.decommissionRetentionDays ?? 90) * 86_400_000;
    const gone = await this.prisma.database.findMany({ where: { status: 'DECOMMISSIONED', decommissionedAt: { lt: new Date(this.now().getTime() - goneMs) } }, select: { id: true } });
    const goneTargets = new Set<string>();
    for (const g of gone) {
      goneTargets.add(`db:${g.id}`);
      for (const r of await this.prisma.backupJob.findMany({ where: { databaseId: g.id, status: 'SUCCESS', deletedAt: null }, select: { id: true, objectKey: true } })) await expire(r);
    }
    const targets = (await this.prisma.backupJob.findMany({ distinct: ['target'], select: { target: true } })).map((r) => r.target).filter((t) => !goneTargets.has(t));
    for (const target of targets) {
      const rows = await this.prisma.backupJob.findMany({ where: { target, status: 'SUCCESS', deletedAt: null }, select: { id: true, kind: true, startedAt: true, objectKey: true } });
      const scheduled = rows.filter((r) => r.kind === 'SCHEDULED');
      for (const c of selectPrune(scheduled.map((r) => ({ id: r.id, at: r.startedAt })), this.now(), policy)) await expire(scheduled.find((r) => r.id === c.id)!);
      // keep the very newest backup of the target whatever its kind, so pruning can never remove the only restore point
      const newest = rows.reduce((a, b) => (a.startedAt > b.startedAt ? a : b), rows[0]);
      for (const r of rows.filter((x) => x.kind === 'MANUAL' && x.id !== newest?.id && this.now().getTime() - x.startedAt.getTime() > manualMs)) await expire(r);
    }
    if (deleted) await this.audit?.record({ actorName: 'scheduler', action: 'backup.prune', targetType: 'backup', result: 'SUCCESS', metadata: { deleted } });
    return { deleted };
  }
}

/**
 * Swap a verified staging database in for the live one. Connections are closed to the live database first, so the application
 * cannot reconnect between the terminate and the rename; the old copy keeps ALLOW_CONNECTIONS false, so nothing uses it by accident.
 */
export const SWAP_SQL = `
SELECT format('ALTER DATABASE %I WITH ALLOW_CONNECTIONS false', :'db') \\gexec
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = :'db' AND pid <> pg_backend_pid() \\g /dev/null
SELECT format('ALTER DATABASE %I RENAME TO %I', :'db', :'old') \\gexec
SELECT format('ALTER DATABASE %I RENAME TO %I', :'staging', :'db') \\gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'db') \\gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'db', :'backup') \\gexec
`;
