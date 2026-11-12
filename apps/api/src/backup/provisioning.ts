import { randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import type { AuditLike } from './backup-service';
import type { PgConn, PgTools } from './pg-tools';

const IDENT = /^[a-z0-9_]{1,63}$/;

/** Generated, never user-supplied: <app>_<project>_<random>. Postgres identifiers are limited to 63 bytes; these stay well under. */
export function provisionNames(projectSlug: string, rand: string = randomBytes(3).toString('hex')) {
  const base = projectSlug.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'db';
  const pgName = `app_${base}_${rand}`;
  return { pgName, roleName: `${pgName}_u` };
}

/** 32 random bytes as base64url: URL-safe, so it can sit inside a connection string without escaping. */
export const generatePassword = () => randomBytes(32).toString('base64url');

export interface SecretWriter {
  set(environmentId: string, name: string, value: string, userId?: string): Promise<unknown>;
  /** Needed to remove a database again: the connection string is only deleted if it still points at the database being removed. */
  remove?(environmentId: string, name: string): Promise<unknown>;
  forEnvironment?(environmentId: string): Promise<string[]>;
}

/** What the data worker's final backup reports (BackupService.backup returns the BackupJob row). */
export interface FinalBackupResult { status: string; error?: string | null; id?: string }

export interface ProvisionerConfig {
  host: string;
  port: number;
  /** aegis_provisioner: CREATEROLE + CREATEDB, no superuser. */
  user: string;
  password: string;
  /** The host the APPLICATION reaches Postgres on (inside the Docker network). Defaults to `host`. */
  appHost?: string;
  /** The role granted CONNECT on every provisioned database so it can be backed up. */
  backupRole: string;
}

/**
 * FR-DB-1: provision a PostgreSQL database and a LEAST-PRIVILEGED role for a project environment, with no human running SQL.
 *
 * The role can log in and own exactly one database. It is not a superuser and cannot create databases or roles; the database is
 * closed to PUBLIC. The password never touches the AegisOps tables, a command line or the logs: it goes to Postgres and into the
 * environment's encrypted DATABASE_URL secret, which the deployer injects into the app's container.
 */
export class DatabaseProvisioner {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly pg: PgTools,
    private readonly secrets: SecretWriter,
    private readonly cfg: ProvisionerConfig,
    private readonly audit?: AuditLike,
  ) {}

  private conn(): PgConn {
    return { host: this.cfg.host, port: this.cfg.port, user: this.cfg.user, password: this.cfg.password, database: 'postgres' };
  }

  /** Works on a Database row already created with status PROVISIONING (names reserved by the API, which keeps them unique). */
  async provision(databaseId: string, requestedById?: string) {
    const row = await this.prisma.database.findUniqueOrThrow({ where: { id: databaseId } });
    if (row.status !== 'PROVISIONING') return row;
    if (!IDENT.test(row.pgName) || !IDENT.test(row.roleName)) throw new Error('refusing unsafe database or role names');
    if (!row.environmentId) throw new Error('a provisioned database needs an environment to receive its connection string');

    const password = generatePassword();
    let created = false;
    try {
      await this.pg.runScript(this.conn(), PROVISION_SQL, { role: row.roleName, db: row.pgName, pw: password, backup: this.cfg.backupRole });
      created = true;
      const url = `postgresql://${row.roleName}:${password}@${this.cfg.appHost ?? this.cfg.host}:${this.cfg.port}/${row.pgName}`;
      await this.secrets.set(row.environmentId, 'DATABASE_URL', url, requestedById);

      const ready = await this.prisma.database.update({ where: { id: row.id }, data: { status: 'READY', error: null } });
      await this.audit?.record({ actorId: requestedById, actorName: requestedById ? undefined : 'system', action: 'database.provision', targetType: 'database', targetId: row.id, result: 'SUCCESS', metadata: { database: row.pgName, role: row.roleName, environmentId: row.environmentId } });
      return ready;
    } catch (e) {
      // Leave nothing half-made: a failed provision drops whatever it created.
      if (created) await this.pg.runScript(this.conn(), CLEANUP_SQL, { role: row.roleName, db: row.pgName }).catch(() => undefined);
      const message = (e instanceof Error ? e.message : String(e)).replace(password, '***').slice(0, 400);
      const failed = await this.prisma.database.update({ where: { id: row.id }, data: { status: 'FAILED', error: message } });
      await this.audit?.record({ actorId: requestedById, actorName: requestedById ? undefined : 'system', action: 'database.provision', targetType: 'database', targetId: row.id, result: 'ERROR', metadata: { error: message } });
      return failed;
    }
  }

  /**
   * Removes a provisioned database and its role (deprovisioning). The order is the safety:
   *  1. a final backup is taken and must SUCCEED: if it does not, nothing is dropped and the database goes back to READY;
   *  2. new connections are refused, the existing ones ended, then the database, any copies the role owns (restores into a new
   *     database, _old_ copies from an overwrite: Postgres will not drop a role that still owns one) and the role are dropped;
   *  3. the environment's DATABASE_URL is deleted, but only if it still points at THIS database (someone may have replaced it);
   *  4. the row stays as DECOMMISSIONED so its backups can still be found and restored into a new database until they expire.
   * Expects the row to be DECOMMISSIONING (the API sets that when it queues the job, which also stops backups and overwrites meanwhile).
   */
  async deprovision(databaseId: string, opts: { requestedById?: string; reason?: string; finalBackup: () => Promise<FinalBackupResult> }) {
    const row = await this.prisma.database.findUniqueOrThrow({ where: { id: databaseId } });
    if (row.status !== 'DECOMMISSIONING') return row;
    if (!IDENT.test(row.pgName) || !IDENT.test(row.roleName)) throw new Error('refusing unsafe database or role names');
    const actor = { actorId: opts.requestedById, actorName: opts.requestedById ? undefined : 'system' };
    const meta = { database: row.pgName, role: row.roleName, environmentId: row.environmentId, reason: opts.reason };
    const refuse = async (message: string, status: 'READY' | 'FAILED') => {
      const back = await this.prisma.database.update({ where: { id: row.id }, data: { status, error: message.slice(0, 400) } });
      await this.audit?.record({ ...actor, action: 'database.deprovision', targetType: 'database', targetId: row.id, result: 'ERROR', metadata: { ...meta, error: message.slice(0, 400) } });
      return back;
    };

    // A database that was never created (or already dropped by an interrupted removal) has nothing to back up.
    const exists = (await this.pg.query(this.conn(), `SELECT 1 FROM pg_database WHERE datname = '${row.pgName}'`)).trim() === '1';
    let finalBackupId: string | undefined;
    if (exists) {
      let result: FinalBackupResult;
      try {
        result = await opts.finalBackup();
      } catch (e) {
        result = { status: 'FAILED', error: e instanceof Error ? e.message : String(e) };
      }
      if (result.status !== 'SUCCESS') return refuse(`refused: the final backup failed (${result.error ?? 'unknown error'}); nothing was dropped`, 'READY');
      finalBackupId = result.id;
    }

    // Recorded before the drop, so the audit log says exactly which copies went with it.
    const droppedCopies = (await this.pg.query(this.conn(), OWNED_COPIES_SQL(row.roleName, row.pgName))).split('\n').map((s) => s.trim()).filter(Boolean);
    try {
      await this.pg.runScript(this.conn(), DECOMMISSION_SQL, { role: row.roleName, db: row.pgName });
    } catch (e) {
      return refuse(`the drop failed: ${e instanceof Error ? e.message : String(e)}; run the removal again`, 'FAILED');
    }

    let secretRemoved = false;
    if (row.environmentId && this.secrets.remove && this.secrets.forEnvironment) {
      const lines = await this.secrets.forEnvironment(row.environmentId);
      const url = lines.find((l) => l.startsWith('DATABASE_URL='));
      if (url && url.includes(`://${row.roleName}:`)) {
        await this.secrets.remove(row.environmentId, 'DATABASE_URL');
        secretRemoved = true;
      }
    }

    const done = await this.prisma.database.update({
      where: { id: row.id },
      // The label is freed so the project can create a new database with the same name.
      data: { status: 'DECOMMISSIONED', error: null, decommissionedAt: new Date(), name: `${row.name}~removed-${row.id.slice(0, 6)}` },
    });
    await this.audit?.record({ ...actor, action: 'database.deprovision', targetType: 'database', targetId: row.id, result: 'SUCCESS', metadata: { ...meta, finalBackupId: finalBackupId ?? null, secretRemoved, droppedCopies } });
    return done;
  }

  /**
   * Rotates the application role's password. Postgres has no two-passwords-at-once, so the order is what keeps this safe:
   *  1. the CURRENT password is read from the environment's DATABASE_URL (which must still point at this role, or there is nowhere to
   *     deliver a new one and nothing is changed);
   *  2. the role gets the new password, and a real login with it is proven;
   *  3. only then is DATABASE_URL replaced; if that fails, the old password is put back, so the application is never left with a
   *     secret that does not work.
   * Connections the application already holds stay open (Postgres does not drop them); it must be redeployed to pick up the new
   * secret before it next connects. The password never touches an AegisOps table, the audit log or an error message.
   */
  async rotatePassword(databaseId: string, opts: { requestedById?: string; reason?: string } = {}) {
    const row = await this.prisma.database.findUniqueOrThrow({ where: { id: databaseId } });
    if (row.status !== 'READY') return row;
    if (!IDENT.test(row.pgName) || !IDENT.test(row.roleName)) throw new Error('refusing unsafe database or role names');
    const actor = { actorId: opts.requestedById, actorName: opts.requestedById ? undefined : 'system' };
    const meta = { database: row.pgName, role: row.roleName, environmentId: row.environmentId, reason: opts.reason };
    const fail = async (message: string) => {
      const clean = message.slice(0, 400);
      const back = await this.prisma.database.update({ where: { id: row.id }, data: { rotationError: clean } });
      await this.audit?.record({ ...actor, action: 'database.rotate_password', targetType: 'database', targetId: row.id, result: 'ERROR', metadata: { ...meta, error: clean } });
      return back;
    };
    if (!row.environmentId || !this.secrets.forEnvironment) return fail('refused: this database has no environment to deliver a new connection string to; nothing was changed');

    const current = (await this.secrets.forEnvironment(row.environmentId)).find((l) => l.startsWith('DATABASE_URL='))?.slice('DATABASE_URL='.length);
    const m = current ? /^postgresql:\/\/([^:]+):([^@]+)@([^:/]+):(\d+)\/(.+)$/.exec(current) : null;
    if (!m || m[1] !== row.roleName || m[5] !== row.pgName) {
      return fail('refused: the environment\'s DATABASE_URL no longer points at this database, so a new password could not be delivered; nothing was changed');
    }
    const [, , oldPassword, host, port] = m;
    const password = generatePassword();
    const scrub = (text: string) => text.split(password).join('***').split(oldPassword).join('***');
    const set = (pw: string) => this.pg.runScript(this.conn(), ROTATE_SQL, { role: row.roleName, pw });
    const login = (pw: string) => this.pg.query({ host: this.cfg.host, port: this.cfg.port, user: row.roleName, password: pw, database: row.pgName }, 'SELECT 1');

    try {
      await set(password);
    } catch (e) {
      return fail(`the password could not be changed: ${scrub(e instanceof Error ? e.message : String(e))}; nothing was changed`);
    }
    const putBack = async () => (/^[A-Za-z0-9_-]+$/.test(oldPassword) ? set(oldPassword).then(() => true, () => false) : false);
    try {
      if ((await login(password)).trim() !== '1') throw new Error('the new password did not open a session');
      await this.secrets.set(row.environmentId, 'DATABASE_URL', `postgresql://${row.roleName}:${password}@${host}:${port}/${row.pgName}`, opts.requestedById);
    } catch (e) {
      const restored = await putBack();
      return fail(`the new password was not delivered (${scrub(e instanceof Error ? e.message : String(e))}); ${restored ? 'the old password was put back and the application is unaffected' : 'THE OLD PASSWORD COULD NOT BE PUT BACK: the role now has a password that is not stored anywhere, so rotate again'}`);
    }

    const done = await this.prisma.database.update({ where: { id: row.id }, data: { passwordRotatedAt: new Date(), rotationError: null } });
    await this.audit?.record({ ...actor, action: 'database.rotate_password', targetType: 'database', targetId: row.id, result: 'SUCCESS', metadata: { ...meta, redeployNeeded: true } });
    return done;
  }
}

/** The new password is a base64url value (letters, digits, - and _): safe inside the quoted psql variable and the connection string. */
export const ROTATE_SQL = `
SELECT format('ALTER ROLE %I PASSWORD %L', :'role', :'pw') \\gexec
`;

/**
 * Refuse new connections, then drop every database the role owns (the live one, plus any copies made for it: restores into a new
 * database and the _old_ copies an overwrite leaves, which Postgres would otherwise refuse to let the role go while they exist),
 * ending connections to them, and finally the role. Safe to run again after an interruption.
 */
export const DECOMMISSION_SQL = `
SELECT format('ALTER DATABASE %I WITH ALLOW_CONNECTIONS false', :'db') WHERE EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db') \\gexec
SELECT format('DROP DATABASE IF EXISTS %I WITH (FORCE)', d.datname) FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba WHERE r.rolname = :'role' AND d.datname <> :'db' \\gexec
SELECT format('DROP DATABASE IF EXISTS %I WITH (FORCE)', :'db') \\gexec
SELECT format('DROP ROLE IF EXISTS %I', :'role') \\gexec
`;

/** Databases other than the live one that this role owns: what a removal will drop along with it. */
export const OWNED_COPIES_SQL = (role: string, db: string) =>
  `SELECT d.datname FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba WHERE r.rolname = '${role}' AND d.datname <> '${db}' ORDER BY 1`;

export const PROVISION_SQL = `
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', :'role', :'pw') \\gexec
SELECT format('CREATE DATABASE %I OWNER %I', :'db', :'role') \\gexec
SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'db') \\gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'db', :'backup') \\gexec
`;

export const CLEANUP_SQL = `
SELECT format('DROP DATABASE IF EXISTS %I', :'db') \\gexec
SELECT format('DROP ROLE IF EXISTS %I', :'role') \\gexec
`;
