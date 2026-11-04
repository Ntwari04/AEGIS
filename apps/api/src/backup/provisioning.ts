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
}

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
}

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
