/**
 * Backup & Recovery against REAL services (PRD 6.7, FR-BACKUP-1..5, FR-DB-4): PostgreSQL 16 with the real pg_dump / psql
 * (run inside the Postgres container), and a real S3-compatible object store (SeaweedFS). Needs Docker.
 */
import 'reflect-metadata';
import { execSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaClient } from '@prisma/client';
import { BackupService, targetKey, type Target } from '../src/backup/backup-service';
import { S3ObjectStore } from '../src/backup/object-store';
import { PgTools, type PgConn } from '../src/backup/pg-tools';
import { recover } from '../src/backup/recover';

jest.setTimeout(600_000);

const suffix = randomBytes(3).toString('hex');
const pgName = `aegis-bk-pg-${suffix}`;
let pg: StartedPostgreSqlContainer;
let s3c: StartedTestContainer;
let prisma: PrismaClient;
let store: S3ObjectStore;
let tools: PgTools;
let svc: BackupService;
let appDbId: string;
const audit: { action: string; result: string; metadata?: any }[] = [];
const key = randomBytes(32);

// pg_dump / psql run INSIDE the Postgres container (this host has no Postgres client tools): same binaries, same flags.
const su = (database: string): PgConn => ({ host: 'localhost', port: 5432, user: 'test', password: 'test', database });
const sql = (database: string, text: string) => tools.query(su(database), text);
const asBackup = (database: string): PgConn => ({ host: 'localhost', port: 5432, user: 'aegis_backup', password: 'bk-pass', database });

const app: Target = { kind: 'db', get id() { return appDbId; } } as Target;
const sys: Target = { kind: 'system', name: 'aegisops' };

async function objectBytes(k: string) {
  const chunks: Buffer[] = [];
  for await (const c of await store.get(k)) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const dbExists = async (name: string) => (await sql('postgres', `SELECT count(*) FROM pg_database WHERE datname='${name}'`)).trim() === '1';

beforeAll(async () => {
  pg = await new PostgreSqlContainer('postgres:16-alpine').withName(pgName).withDatabase('aegisops').start();
  s3c = await new GenericContainer('chrislusf/seaweedfs:4.50')
    .withCommand(['server', '-s3', '-dir=/data', '-volume.max=4', '-master.volumeSizeLimitMB=64'])
    .withExposedPorts(8333)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();

  tools = new PgTools(['docker', 'exec', '-i', pgName]);
  execSync('npx prisma migrate deploy', { cwd: join(__dirname, '..'), env: { ...process.env, DATABASE_URL: pg.getConnectionUri() }, stdio: 'pipe' });
  prisma = new PrismaClient({ datasources: { db: { url: pg.getConnectionUri() } } });

  // Production-like roles: the backup role reads everything and may create scratch databases, but is not a superuser.
  await sql('postgres', `CREATE ROLE aegis_backup LOGIN PASSWORD 'bk-pass' CREATEDB NOSUPERUSER`);
  await sql('postgres', `GRANT pg_read_all_data TO aegis_backup`);
  // The provisioner creates roles and databases; createrole_self_grant lets it act as the roles it creates; pg_signal_backend lets
  // the overwrite swap close connections to a live database. Not a superuser.
  await sql('postgres', `CREATE ROLE aegis_provisioner LOGIN PASSWORD 'pv-pass' NOSUPERUSER CREATEROLE CREATEDB`);
  await sql('postgres', `ALTER ROLE aegis_provisioner SET createrole_self_grant = 'set, inherit'`);
  await sql('postgres', `GRANT pg_signal_backend TO aegis_provisioner`);
  // As infra/postgres/init/02-data-roles.sh does: nobody but the data roles may connect to the default databases.
  for (const d of ['postgres', 'template1', 'aegisops']) await sql('postgres', `REVOKE CONNECT ON DATABASE ${d} FROM PUBLIC`);
  for (const r of ['aegis_backup', 'aegis_provisioner']) await sql('postgres', `GRANT CONNECT ON DATABASE postgres TO ${r}`);
  for (const db of ['sysdb', 'kcdb', 'appdata', 'locked']) {
    await sql('postgres', `CREATE DATABASE ${db}`);
    await sql('postgres', `REVOKE ALL ON DATABASE ${db} FROM PUBLIC`); // like infra/postgres/init
    if (db !== 'locked') await sql('postgres', `GRANT CONNECT ON DATABASE ${db} TO aegis_backup`);
  }
  await sql('sysdb', `CREATE TABLE settings(k text primary key, v text); INSERT INTO settings VALUES ('a','1'),('b','2')`);
  await sql('kcdb', `CREATE TABLE realm(id serial primary key, name text); INSERT INTO realm(name) VALUES ('aegisops')`);
  await sql('appdata', `
    CREATE TABLE customers(id serial primary key, name text not null, note text);
    INSERT INTO customers(name, note) SELECT 'Customer ' || g, 'Ünïcödé ✓ 日本語 ' || repeat('x', 200) FROM generate_series(1, 5000) g;
    CREATE TABLE orders(id serial primary key, customer_id int references customers(id), total numeric(10,2), placed timestamptz default now());
    INSERT INTO orders(customer_id, total) SELECT (g % 5000) + 1, (g * 1.37)::numeric(10,2) FROM generate_series(1, 12000) g;
    CREATE INDEX orders_customer ON orders(customer_id);
    CREATE VIEW big_orders AS SELECT * FROM orders WHERE total > 100;
    CREATE SCHEMA audit;
    CREATE TABLE audit.events(id bigserial primary key, what text);
    INSERT INTO audit.events(what) SELECT 'event ' || g FROM generate_series(1, 100) g;
    CREATE TABLE empty_table(id int)`);

  store = new S3ObjectStore({ endpoint: `http://${s3c.getHost()}:${s3c.getMappedPort(8333)}`, bucket: 'aegis-test-backups', region: 'us-east-1', accessKeyId: 'test', secretAccessKey: 'test', forcePathStyle: true });
  for (let i = 0; ; i++) {
    try { await store.ensureBucket(); await store.list(''); break; } catch (e) { if (i > 30) throw e; await new Promise((r) => setTimeout(r, 1000)); }
  }

  await tools.query({ host: 'localhost', port: 5432, user: 'aegis_provisioner', password: 'pv-pass', database: 'postgres' }, 'CREATE ROLE appdata_role NOLOGIN');
  const project = await prisma.project.create({ data: { name: 'BK', slug: 'bk' } });
  appDbId = (await prisma.database.create({ data: { projectId: project.id, name: 'appdata', pgName: 'appdata', roleName: 'appdata_role' } })).id;

  svc = new BackupService(prisma, store, tools, {
    host: 'localhost', port: 5432, user: 'aegis_backup', password: 'bk-pass', provisioner: { user: 'aegis_provisioner', password: 'pv-pass' },
    systemDatabases: { aegisops: 'sysdb', keycloak: 'kcdb' }, encryptionKey: key, rtoSeconds: 4 * 3600, keyPrefix: 'aegisops/',
  }, { record: async (e) => void audit.push({ action: e.action, result: e.result, metadata: e.metadata }) });
});

afterAll(async () => {
  await prisma?.$disconnect();
  await s3c?.stop().catch(() => undefined);
  await pg?.stop().catch(() => undefined);
});

describe('backup', () => {
  let job: Awaited<ReturnType<BackupService['backup']>>;

  it('backs up a provisioned database: encrypted, off-host, checksummed, with an exact row-count manifest', async () => {
    job = await svc.backup(app, { kind: 'MANUAL', triggeredById: 'user-1' });
    expect(job.status).toBe('SUCCESS');
    expect(job.target).toBe(`db:${appDbId}`);
    expect(job.objectKey).toMatch(/^aegisops\/db\/[0-9a-f-]{36}\/\d{4}\/\d{2}\/\d{2}\/\d{8}T\d{6}Z-[0-9a-f]{8}\.sql\.gz\.enc$/);
    expect(job.manifest).toMatchObject({ 'public.customers': 5000, 'public.orders': 12000, 'audit.events': 100, 'public.empty_table': 0 });
    expect(Number(job.plainBytes)).toBeGreaterThan(Number(job.sizeBytes)); // gzip really compressed it

    // the object in the store is exactly what the record says, and it is ciphertext
    const bytes = await objectBytes(job.objectKey!);
    expect(bytes.length).toBe(Number(job.sizeBytes));
    expect(sha(bytes)).toBe(job.sha256);
    expect(bytes.subarray(0, 8).toString()).toBe('AEGISBK1');
    for (const needle of ['Customer 1', 'CREATE TABLE', 'Ünïcödé', 'audit.events', 'PostgreSQL database dump']) {
      expect(bytes.includes(Buffer.from(needle))).toBe(false);
    }
    expect(audit.some((a) => a.action === 'backup.finish' && a.result === 'SUCCESS')).toBe(true);
  });

  it('backs up the system databases too (FR-BACKUP-1: AegisOps itself and Keycloak)', async () => {
    const a = await svc.backup(sys);
    const k = await svc.backup({ kind: 'system', name: 'keycloak' });
    expect([a.status, k.status]).toEqual(['SUCCESS', 'SUCCESS']);
    expect(a.manifest).toMatchObject({ 'public.settings': 2 });
    expect(k.manifest).toMatchObject({ 'public.realm': 1 });
    expect(a.databaseId).toBeNull();
  });

  it('a backup is a point in time: later writes are not in it', async () => {
    const before = await svc.backup(app);
    await sql('appdata', `INSERT INTO customers(name, note) VALUES ('Late', 'written after the backup')`);
    const r = await svc.restoreToNew(before.id, { requestedById: 'user-1' });
    expect(r.status).toBe('SUCCESS');
    const restored = (await sql(r.targetDatabase, `SELECT count(*) FROM customers`)).trim();
    expect(restored).toBe('5000'); // not 5001
    await sql('postgres', `DROP DATABASE ${r.targetDatabase}`);
    await sql('appdata', `DELETE FROM customers WHERE name = 'Late'`);
  });
});

describe('restore to a NEW database and integrity (FR-DB-4)', () => {
  it('restores everything: data, unicode, sequences, views, indexes, schemas; the original is untouched', async () => {
    const b = await svc.backup(app);
    const r = await svc.restoreToNew(b.id, { requestedById: 'user-1', reason: 'inspect last night' });
    expect(r.status).toBe('SUCCESS');
    expect(r.kind).toBe('RESTORE');
    expect(r.targetDatabase).toMatch(/^restore_db_[0-9a-f_]+_\d+$/);
    expect(r.integrity).toMatchObject({ ok: true, checksumVerified: true, authenticated: true, withinRto: true, tables: 4 });
    expect((r.integrity as any).rows).toBe(5000 + 12000 + 100 + 0);
    expect(r.durationMs).toBeGreaterThan(0);

    const into = r.targetDatabase;
    expect((await sql(into, `SELECT note FROM customers WHERE id = 42`)).trim()).toContain('Ünïcödé ✓ 日本語');
    expect((await sql(into, `SELECT count(*) FROM big_orders`)).trim()).toBe((await sql('appdata', `SELECT count(*) FROM big_orders`)).trim());
    expect((await sql(into, `SELECT count(*) FROM pg_indexes WHERE indexname = 'orders_customer'`)).trim()).toBe('1');
    expect((await sql(into, `SELECT count(*) FROM audit.events`)).trim()).toBe('100');
    // sequences carry over: the restored one continues exactly where the source's sequence stands
    const next = Number((await sql('appdata', `SELECT last_value FROM customers_id_seq`)).trim()) + 1;
    expect(Number((await sql(into, `INSERT INTO customers(name) VALUES ('after restore') RETURNING id`)).trim().split('\n')[0])).toBe(next);
    // the live database is exactly as it was
    expect((await sql('appdata', `SELECT count(*) FROM customers`)).trim()).toBe('5000');
    expect(await dbExists('appdata')).toBe(true);
    await sql('postgres', `DROP DATABASE ${into}`);
  });

  it('refuses unsafe or non-new target names (never restores over an existing database)', async () => {
    const b = await svc.backup(app);
    await expect(svc.restoreToNew(b.id, { targetName: 'appdata' })).rejects.toThrow(/restore_/);
    await expect(svc.restoreToNew(b.id, { targetName: 'restore_x"; DROP DATABASE appdata; --' })).rejects.toThrow(/restore_/);
    await expect(svc.restoreToNew(b.id, { targetName: 'postgres' })).rejects.toThrow(/restore_/);
    expect(await dbExists('appdata')).toBe(true);
  });

  it('a failed restore leaves no half-restored database behind', async () => {
    const b = await svc.backup(app);
    // corrupt a chunk but keep the recorded checksum matching, so the failure happens during decryption, mid-restore
    const bytes = Buffer.from(await objectBytes(b.objectKey!));
    bytes[bytes.length - 100] ^= 1;
    await store.put(b.objectKey!, Readable.from([bytes]));
    await prisma.backupJob.update({ where: { id: b.id }, data: { sha256: sha(bytes) } });
    const r = await svc.restoreToNew(b.id, { targetName: 'restore_halfway' });
    expect(r.status).toBe('FAILED');
    expect(r.error).toMatch(/authentication|failed/i);
    expect(await dbExists('restore_halfway')).toBe(false);
  });
});

describe('tampering and wrong keys', () => {
  it('detects an archive modified in storage (checksum) BEFORE executing anything', async () => {
    const b = await svc.backup(sys);
    const bytes = Buffer.from(await objectBytes(b.objectKey!));
    bytes[bytes.length - 50] ^= 1;
    await store.put(b.objectKey!, Readable.from([bytes]));
    const r = await svc.restoreToNew(b.id, { targetName: 'restore_tampered' });
    expect(r.status).toBe('FAILED');
    expect(r.error).toMatch(/checksum/);
    expect(await dbExists('restore_tampered')).toBe(false); // not even created
  });

  it('says plainly when the archive is missing from storage (for example after the storage location changed)', async () => {
    const b = await svc.backup(sys);
    await store.delete(b.objectKey!);
    const r = await svc.restoreToNew(b.id, { targetName: 'restore_missing' });
    expect(r.status).toBe('FAILED');
    expect(r.error).toMatch(/missing from object storage/);
    expect(await dbExists('restore_missing')).toBe(false);
  });

  it('detects a valid-but-different archive swapped in (replay of an older backup)', async () => {
    const newer = await svc.backup(sys);
    const older = await svc.backup(sys);
    await store.put(newer.objectKey!, Readable.from([await objectBytes(older.objectKey!)]));
    const r = await svc.restoreToNew(newer.id, { targetName: 'restore_swapped' });
    expect(r.status).toBe('FAILED');
    expect(r.error).toMatch(/checksum/);
  });

  it('cannot be restored with a different encryption key', async () => {
    const b = await svc.backup(sys);
    const other = new BackupService(prisma, store, tools, { ...(svc as any).cfg, encryptionKey: randomBytes(32) });
    const r = await other.restoreToNew(b.id, { targetName: 'restore_wrongkey' });
    expect(r.status).toBe('FAILED');
    expect(r.error).toMatch(/authentication/);
    expect(await dbExists('restore_wrongkey')).toBe(false);
  });

  it('fails the integrity check when the restore does not match the manifest, and drops the database', async () => {
    const b = await svc.backup(sys);
    await prisma.backupJob.update({ where: { id: b.id }, data: { manifest: { 'public.settings': 999 } } });
    const r = await svc.restoreToNew(b.id, { targetName: 'restore_mismatch' });
    expect(r.status).toBe('FAILED');
    expect(r.error).toMatch(/integrity/);
    expect((r.integrity as any).mismatched).toEqual([{ table: 'public.settings', expected: 999, actual: 2 }]);
    expect(await dbExists('restore_mismatch')).toBe(false);
  });
});

describe('failures are recorded honestly (FR-BACKUP-5)', () => {
  it('a backup that cannot run is FAILED with a reason, and leaves no object behind', async () => {
    const project = await prisma.project.findFirstOrThrow({ where: { slug: 'bk' } });
    const locked = await prisma.database.create({ data: { projectId: project.id, name: 'locked', pgName: 'locked', roleName: 'locked_role' } });
    const before = (await store.list('')).length;
    const job = await svc.backup({ kind: 'db', id: locked.id });
    expect(job.status).toBe('FAILED');
    expect(job.error).toBeTruthy();
    expect(job.objectKey).toBeNull();
    expect(job.finishedAt).not.toBeNull();
    expect((await store.list('')).length).toBe(before);
    expect(audit.some((a) => a.action === 'backup.finish' && a.result === 'ERROR')).toBe(true);
  });

  it('a nightly run backs up every target and one failing target does not stop the others', async () => {
    const results = await svc.backupAll('SCHEDULED');
    const byTarget = Object.fromEntries(results.map((r) => [r.target, r.status]));
    expect(byTarget['system:aegisops']).toBe('SUCCESS');
    expect(byTarget['system:keycloak']).toBe('SUCCESS');
    expect(byTarget[targetKey(app)]).toBe('SUCCESS');
    expect(Object.values(byTarget)).toContain('FAILED'); // the "locked" database
    expect(results.every((r) => r.kind === 'SCHEDULED')).toBe(true);
  });
});

describe('restore drill (FR-BACKUP-4) and retention (FR-BACKUP-3)', () => {
  it('a drill restores the latest backup of every target into scratch databases, verifies them, and drops them', async () => {
    await svc.backupAll('SCHEDULED');
    const results = await svc.drill();
    expect(results.length).toBeGreaterThanOrEqual(3);
    const ok = results.filter((r) => r.status === 'SUCCESS');
    expect(ok.length).toBeGreaterThanOrEqual(3);
    for (const r of ok) {
      expect(r.kind).toBe('DRILL');
      expect((r.integrity as any).ok).toBe(true);
      expect((r.integrity as any).withinRto).toBe(true);
      expect(await dbExists(r.targetDatabase)).toBe(false); // scratch is gone
    }
    expect(audit.some((a) => a.action === 'backup.drill' && a.result === 'SUCCESS')).toBe(true);
  });

  it('cleans up scratch databases left by a crashed worker, and touches nothing else', async () => {
    // scratch databases are created (and therefore owned) by the backup role itself, which is why it may drop them
    await tools.query(asBackup('postgres'), `CREATE DATABASE drill_deadbeef`);
    await sql('postgres', `CREATE DATABASE keep_me_please`);
    await svc.cleanupScratch();
    expect(await dbExists('drill_deadbeef')).toBe(false);
    expect(await dbExists('keep_me_please')).toBe(true);
    await sql('postgres', `DROP DATABASE keep_me_please`);
  });

  it('prune applies the policy: deletes archives outside it from storage, keeps the newest, keeps history rows', async () => {
    const project = await prisma.project.create({ data: { name: 'Prune', slug: 'prune' } });
    const db = await prisma.database.create({ data: { projectId: project.id, name: 'p', pgName: 'prune_db', roleName: 'p_role' } });
    const target = `db:${db.id}`;
    const day = 86_400_000;
    const ids: Record<string, string> = {};
    // 40 nightly backups; each has a real object in the store
    for (let i = 0; i < 40; i++) {
      const at = new Date(Date.now() - i * day);
      const k = `aegisops/prune-test/${db.id}/${i}.bin`;
      await store.put(k, Readable.from([Buffer.from(`archive ${i}`)]));
      const row = await prisma.backupJob.create({ data: { target, databaseId: db.id, status: 'SUCCESS', objectKey: k, sha256: 'x', startedAt: at, finishedAt: at } });
      ids[i] = row.id;
    }
    // Manual backups are not displaced by nightly ones: a recent one survives, an old one expires.
    const manual = async (daysOld: number) => {
      const at = new Date(Date.now() - daysOld * day);
      const k = `aegisops/prune-test/${db.id}/manual-${daysOld}.bin`;
      await store.put(k, Readable.from([Buffer.from('manual')]));
      return prisma.backupJob.create({ data: { target, databaseId: db.id, kind: 'MANUAL', status: 'SUCCESS', objectKey: k, sha256: 'x', startedAt: at, finishedAt: at } });
    };
    const recentManual = await manual(0.2); // same day as the newest nightly: must NOT be pruned
    const oldManual = await manual(45);

    const { deleted } = await svc.prune();
    expect(deleted).toBeGreaterThan(5);

    const alive = await prisma.backupJob.findMany({ where: { target, deletedAt: null } });
    const aliveIds = new Set(alive.map((a) => a.id));
    for (let i = 0; i < 14; i++) expect(aliveIds.has(ids[i])).toBe(true); // every nightly of the last 14 days
    expect(aliveIds.has(recentManual.id)).toBe(true);
    expect(aliveIds.has(oldManual.id)).toBe(false);
    expect(alive.filter((a) => a.kind === 'SCHEDULED').length).toBeLessThan(40);
    // the objects of pruned rows are really gone from storage; rows remain as history
    const pruned = await prisma.backupJob.findMany({ where: { target, deletedAt: { not: null } } });
    expect(pruned.length).toBeGreaterThan(5);
    for (const p of pruned) expect(await store.size(p.objectKey!)).toBeNull();
    for (const a of alive) expect(await store.size(a.objectKey!)).not.toBeNull();
    expect(audit.some((a) => a.action === 'backup.prune')).toBe(true);
  });

  it('a pruned or failed backup cannot be restored', async () => {
    const gone = await prisma.backupJob.findFirstOrThrow({ where: { deletedAt: { not: null } } });
    await expect(svc.restoreToNew(gone.id)).rejects.toThrow(/not restorable/);
    const failed = await prisma.backupJob.findFirstOrThrow({ where: { status: 'FAILED' } });
    await expect(svc.restoreToNew(failed.id)).rejects.toThrow(/not restorable/);
  });
});

// ======================================================================================================================
// Database management (FR-DB-1, FR-DB-4)
// ======================================================================================================================
import { DatabaseProvisioner, provisionNames } from '../src/backup/provisioning';
import { SecretsCrypto } from '../src/secrets/secrets-crypto';
import { SecretsService } from '../src/secrets/secrets.service';

describe('database provisioning (FR-DB-1)', () => {
  let secrets: SecretsService;
  let prov: DatabaseProvisioner;
  let envId: string;
  let projectId: string;

  beforeAll(async () => {
    secrets = SecretsService.withCrypto(prisma as any, new SecretsCrypto(randomBytes(32).toString('base64')));
    prov = new DatabaseProvisioner(prisma, tools, secrets, { host: 'localhost', port: 5432, user: 'aegis_provisioner', password: 'pv-pass', backupRole: 'aegis_backup', appHost: 'postgres' },
      { record: async (e) => void audit.push({ action: e.action, result: e.result, metadata: e.metadata }) });
    projectId = (await prisma.project.create({ data: { name: 'Prov', slug: 'prov' } })).id;
    envId = (await prisma.environment.create({ data: { projectId, name: 'staging' } })).id;
  });

  const reserve = async (envOverride: string | null = envId, rand?: string) => {
    const names = provisionNames('prov', rand);
    return prisma.database.create({ data: { projectId, environmentId: envOverride, name: `db-${names.pgName}`, ...names, status: 'PROVISIONING' } });
  };
  const credentials = async () => {
    const url = (await secrets.forEnvironment(envId)).find((s) => s.startsWith('DATABASE_URL='))!.slice('DATABASE_URL='.length);
    const m = /^postgresql:\/\/([^:]+):([^@]+)@([^:]+):(\d+)\/(.+)$/.exec(url)!;
    return { url, user: m[1], password: m[2], database: m[5] };
  };
  const asApp = (c: { user: string; password: string }, database: string): PgConn => ({ host: 'localhost', port: 5432, user: c.user, password: c.password, database });

  it('generates safe, bounded, unique identifiers from the project slug', () => {
    const a = provisionNames('My Shop!!', 'abc123');
    expect(a).toEqual({ pgName: 'app_my_shop_abc123', roleName: 'app_my_shop_abc123_u' });
    expect(provisionNames('x'.repeat(80), 'abc123').pgName.length).toBeLessThanOrEqual(41);
    expect(provisionNames('---', 'abc123').pgName).toBe('app_db_abc123');
    expect(provisionNames('a', 'aaaaaa').pgName).not.toBe(provisionNames('a', 'bbbbbb').pgName);
  });

  it('creates a role and database; the role is least-privilege and the database is private', async () => {
    const row = await prov.provision((await reserve()).id, 'user-1');
    expect(row.status).toBe('READY');
    const c = await credentials();
    expect(c.database).toBe(row.pgName);
    expect(c.user).toBe(row.roleName);

    // it owns exactly its own database and can use it freely
    await tools.query(asApp(c, row.pgName), 'CREATE TABLE t(id int); INSERT INTO t VALUES (1),(2);');
    expect((await tools.query(asApp(c, row.pgName), 'SELECT count(*) FROM t')).trim()).toBe('2');

    // ...but it is not a superuser and cannot create databases or roles
    expect((await tools.query(asApp(c, row.pgName), "SELECT current_setting('is_superuser')")).trim()).toBe('off');
    await expect(tools.query(asApp(c, row.pgName), 'CREATE DATABASE nope')).rejects.toThrow(/permission denied/);
    await expect(tools.query(asApp(c, row.pgName), 'CREATE ROLE nope')).rejects.toThrow(/permission denied/);
    // ...and cannot reach any other database (PUBLIC was revoked, only the owner may connect)
    for (const other of ['sysdb', 'kcdb', 'appdata', 'aegisops', 'postgres', 'template1']) {
      await expect(tools.query(asApp(c, other), 'SELECT 1')).rejects.toThrow(/permission denied|not currently accepting/);
    }
    // the backup role CAN connect and read, so the database can be backed up
    expect((await tools.query(asBackup(row.pgName), 'SELECT count(*) FROM t')).trim()).toBe('2');
    expect(audit.some((a) => a.action === 'database.provision' && a.result === 'SUCCESS')).toBe(true);
  });

  it('the password lives only in Postgres and in the ENCRYPTED DATABASE_URL secret: never in AegisOps tables, audit or errors', async () => {
    const c = await credentials();
    const stored = await prisma.environmentSecret.findFirstOrThrow({ where: { environmentId: envId, name: 'DATABASE_URL' } });
    expect(stored.valueEnc).not.toContain(c.password);
    expect(JSON.stringify(await prisma.database.findMany())).not.toContain(c.password);
    expect(JSON.stringify(audit)).not.toContain(c.password);
    // the deployer receives it as an environment variable at the next deployment
    expect(c.url).toMatch(/^postgresql:\/\/app_prov_[0-9a-f]{6}_u:[A-Za-z0-9_-]{43}@postgres:5432\/app_prov_[0-9a-f]{6}$/);
  });

  it('a failed provision leaves NOTHING behind (no role, no database) and reports the failure without leaking the password', async () => {
    const taken = provisionNames('prov', 'dead01');
    await sql('postgres', `CREATE ROLE ${taken.roleName}`); // collides with the role the provisioner wants to create
    const row = await prov.provision((await reserve(envId, 'dead01')).id, 'user-1');
    expect(row.status).toBe('FAILED');
    expect(row.error).toMatch(/already exists/);
    expect(await dbExists(taken.pgName)).toBe(false);
    expect(audit.some((a) => a.action === 'database.provision' && a.result === 'ERROR')).toBe(true);
    await sql('postgres', `DROP ROLE ${taken.roleName}`);
  });

  it('rolls back the database and role when storing the secret fails', async () => {
    const broken = new DatabaseProvisioner(prisma, tools, { set: async () => { throw new Error('secret storage is not configured'); } },
      { host: 'localhost', port: 5432, user: 'aegis_provisioner', password: 'pv-pass', backupRole: 'aegis_backup' });
    const row = await broken.provision((await reserve(envId, 'dead02')).id);
    expect(row.status).toBe('FAILED');
    expect(row.error).toMatch(/not configured/);
    expect(await dbExists(row.pgName)).toBe(false);
    expect((await sql('postgres', `SELECT count(*) FROM pg_roles WHERE rolname='${row.roleName}'`)).trim()).toBe('0');
  });

  it('is idempotent for a READY database, and refuses one with no environment to deliver the connection string to', async () => {
    const ready = await prisma.database.findFirstOrThrow({ where: { projectId, status: 'READY' } });
    expect((await prov.provision(ready.id)).status).toBe('READY');
    await expect(prov.provision((await reserve(null, 'dead03')).id)).rejects.toThrow(/needs an environment/);
  });

  it('a provisioned database is backed up, and restored to a NEW database that its own role can use', async () => {
    const ready = await prisma.database.findFirstOrThrow({ where: { projectId, status: 'READY' } });
    const b = await svc.backup({ kind: 'db', id: ready.id });
    expect(b.status).toBe('SUCCESS');
    expect(b.manifest).toMatchObject({ 'public.t': 2 });
    const r = await svc.restoreToNew(b.id, { requestedById: 'user-1' });
    expect(r.status).toBe('SUCCESS');
    const c = await credentials();
    // owned by the app role: the application can open the restored copy with its own credentials
    expect((await tools.query(asApp(c, r.targetDatabase), 'SELECT count(*) FROM t')).trim()).toBe('2');
    await sql('postgres', `DROP DATABASE ${r.targetDatabase}`);
  });
});

describe('overwrite restore (FR-DB-4): separate, safe, reversible', () => {
  let db: { id: string; pgName: string; roleName: string };
  let cred: { user: string; password: string };
  let projectId: string;

  const app = (database: string): PgConn => ({ host: 'localhost', port: 5432, user: cred.user, password: cred.password, database });

  beforeAll(async () => {
    projectId = (await prisma.project.create({ data: { name: 'Over', slug: 'over' } })).id;
    const envId = (await prisma.environment.create({ data: { projectId, name: 'prod' } })).id;
    const secrets = SecretsService.withCrypto(prisma as any, new SecretsCrypto(randomBytes(32).toString('base64')));
    const prov = new DatabaseProvisioner(prisma, tools, secrets, { host: 'localhost', port: 5432, user: 'aegis_provisioner', password: 'pv-pass', backupRole: 'aegis_backup' });
    const names = provisionNames('over');
    db = await prisma.database.create({ data: { projectId, environmentId: envId, name: 'main', ...names, status: 'PROVISIONING' } });
    expect((await prov.provision(db.id)).status).toBe('READY');
    const url = (await secrets.forEnvironment(envId)).find((s) => s.startsWith('DATABASE_URL='))!;
    const m = /postgresql:\/\/([^:]+):([^@]+)@/.exec(url)!;
    cred = { user: m[1], password: m[2] };
    await tools.query(app(db.pgName), "CREATE TABLE ledger(id serial primary key, note text); INSERT INTO ledger(note) SELECT 'v1 row ' || g FROM generate_series(1, 300) g");
  });

  const count = async (database: string) => Number((await tools.query(app(database), 'SELECT count(*) FROM ledger')).trim());

  it('refuses system databases', async () => {
    const sysBackup = await svc.backup(sys);
    await expect(svc.overwrite(sysBackup.id, { requestedById: 'admin-1', reason: 'because I can' })).rejects.toThrow(/only a provisioned database/);
  });

  it('takes a safety backup, verifies a staged copy, then swaps: the live database becomes the backup, the old one is kept', async () => {
    const v1 = await svc.backup({ kind: 'db', id: db.id }); // 300 rows
    await tools.query(app(db.pgName), "INSERT INTO ledger(note) SELECT 'v2 row ' || g FROM generate_series(1, 200) g");
    expect(await count(db.pgName)).toBe(500);
    const backupsBefore = await prisma.backupJob.count({ where: { databaseId: db.id } });

    const r = await svc.overwrite(v1.id, { requestedById: 'admin-1', reason: 'roll back the bad import' });
    expect(r.error ?? null).toBeNull();
    expect(r.status).toBe('SUCCESS');
    expect(r.kind).toBe('OVERWRITE');
    const integ = r.integrity as any;
    expect(integ).toMatchObject({ ok: true, checksumVerified: true, authenticated: true, swapped: true });
    expect(integ.previousDatabase).toMatch(new RegExp(`^${db.pgName}_old_\\d{14}$`));

    // the live database now holds the backup's data (300 rows), under the same name, still owned by the app role
    expect(await count(db.pgName)).toBe(300);
    expect((await tools.query(app(db.pgName), "SELECT count(*) FROM ledger WHERE note LIKE 'v2%'")).trim()).toBe('0');
    // the previous state is not lost: it is kept as <name>_old_<time>, closed to connections
    expect(await dbExists(integ.previousDatabase)).toBe(true);
    await expect(tools.query(app(integ.previousDatabase), 'SELECT 1')).rejects.toThrow(/not currently accepting|permission denied/);
    // an admin recovers it deliberately by reopening it (documented in docs/phase5-data.md); the 500 rows are all still there
    await sql('postgres', `ALTER DATABASE ${integ.previousDatabase} WITH ALLOW_CONNECTIONS true`);
    expect((await sql(integ.previousDatabase, 'SELECT count(*) FROM ledger')).trim()).toBe('500');
    await sql('postgres', `ALTER DATABASE ${integ.previousDatabase} WITH ALLOW_CONNECTIONS false`);
    // a safety backup of the 500-row state was taken FIRST and can itself be restored
    const safety = await prisma.backupJob.findUniqueOrThrow({ where: { id: integ.safetyBackupId } });
    expect(safety).toMatchObject({ status: 'SUCCESS', kind: 'MANUAL', triggeredById: 'admin-1' });
    expect((safety.manifest as any)['public.ledger']).toBe(500);
    expect(await prisma.backupJob.count({ where: { databaseId: db.id } })).toBe(backupsBefore + 1);
    // no staging database is left, the backup role can still back the swapped database up, and it is audited with the reason
    expect((await sql('postgres', "SELECT count(*) FROM pg_database WHERE datname ~ '^restore_ow_'")).trim()).toBe('0');
    expect((await svc.backup({ kind: 'db', id: db.id })).status).toBe('SUCCESS');
    expect(audit.some((a) => a.action === 'backup.overwrite' && a.result === 'SUCCESS' && a.metadata?.reason === 'roll back the bad import')).toBe(true);
  });

  it('REFUSES to proceed without a safety net: if the current state cannot be backed up, nothing is changed', async () => {
    const good = await svc.backup({ kind: 'db', id: db.id });
    await tools.query(app(db.pgName), "INSERT INTO ledger(note) VALUES ('precious live data')");
    const before = await count(db.pgName);
    await sql('postgres', `REVOKE CONNECT ON DATABASE ${db.pgName} FROM aegis_backup`); // the safety backup will now fail
    try {
      const r = await svc.overwrite(good.id, { requestedById: 'admin-1', reason: 'attempt without a safety net' });
      expect(r.status).toBe('FAILED');
      expect(r.error).toMatch(/refused: the safety backup/);
      expect(await count(db.pgName)).toBe(before); // live data untouched
      expect((await sql('postgres', "SELECT count(*) FROM pg_database WHERE datname ~ '^restore_ow_'")).trim()).toBe('0'); // staging never created
    } finally {
      await sql('postgres', `GRANT CONNECT ON DATABASE ${db.pgName} TO aegis_backup`);
    }
  });

  it('a tampered archive fails at the staging step: the live database is never touched and no staging database is left', async () => {
    const b = await svc.backup({ kind: 'db', id: db.id });
    const bytes = Buffer.from(await objectBytes(b.objectKey!));
    bytes[bytes.length - 40] ^= 1;
    await store.put(b.objectKey!, Readable.from([bytes]));
    await prisma.backupJob.update({ where: { id: b.id }, data: { sha256: sha(bytes) } }); // checksum matches: the failure is in decryption
    const before = await count(db.pgName);
    const r = await svc.overwrite(b.id, { requestedById: 'admin-1', reason: 'restoring a tampered archive' });
    expect(r.status).toBe('FAILED');
    expect(await count(db.pgName)).toBe(before);
    expect((await sql('postgres', "SELECT count(*) FROM pg_database WHERE datname ~ '^restore_ow_'")).trim()).toBe('0');
  });
});

describe('disaster recovery without the AegisOps database (recover.ts)', () => {
  const opts = (database: string, over: Partial<Parameters<typeof recover>[2]> = {}) => ({
    target: 'aegisops' as const, prefix: 'aegisops/', encryptionKey: key, into: su(database), ...over,
  });
  const tableCount = async (database: string) => Object.keys(await tools.countRows(su(database))).length;

  it('rebuilds the newest archive into an EMPTY database using only the bucket and the key: no AegisOps record is read', async () => {
    await sql('sysdb', `INSERT INTO settings VALUES ('dr-${suffix}','1')`);
    await svc.backup(sys);
    await sql('postgres', 'CREATE DATABASE dr_empty');

    const r = await recover(store, tools, opts('dr_empty'));
    expect(r.objectKey).toMatch(/^aegisops\/system\/aegisops\/.*\.sql\.gz\.enc$/);
    expect(r.counts).toEqual(await tools.countRows(su('sysdb'))); // same tables, same rows as the live database it was taken from
    expect((await sql('dr_empty', `SELECT v FROM settings WHERE k='dr-${suffix}'`)).trim()).toBe('1');
  });

  it('refuses a database that already has tables, and changes nothing in it', async () => {
    const before = await tools.countRows(su('dr_empty'));
    await expect(recover(store, tools, opts('dr_empty'))).rejects.toThrow(/already has \d+ table/);
    expect(await tools.countRows(su('dr_empty'))).toEqual(before);
  });

  it('with the wrong key it applies nothing', async () => {
    await sql('postgres', 'CREATE DATABASE dr_wrong_key');
    await expect(recover(store, tools, opts('dr_wrong_key', { encryptionKey: randomBytes(32) }))).rejects.toThrow();
    expect(await tableCount('dr_wrong_key')).toBe(0);
  });

  it('a damaged archive applies nothing (one transaction) and says so', async () => {
    const b = await svc.backup(sys);
    const bytes = Buffer.from(await objectBytes(b.objectKey!));
    bytes[bytes.length - 40] ^= 1;
    await store.put(b.objectKey!, Readable.from([bytes]));
    await sql('postgres', 'CREATE DATABASE dr_damaged');
    await expect(recover(store, tools, opts('dr_damaged', { objectKey: b.objectKey! }))).rejects.toThrow();
    expect(await tableCount('dr_damaged')).toBe(0);
  });

  it('names a wrong bucket or prefix plainly, and refuses an object that is not a backup of that target', async () => {
    await expect(recover(store, tools, opts('dr_wrong_key', { prefix: 'nothing-here/' }))).rejects.toThrow(/no aegisops backups found/);
    await expect(recover(store, tools, opts('dr_wrong_key', { objectKey: 'aegisops/system/keycloak/x.sql.gz.enc' }))).rejects.toThrow(/not a aegisops backup/);
  });
});
