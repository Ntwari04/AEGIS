import 'reflect-metadata';
import { PrismaClient } from '@prisma/client';
import { Queue, Worker } from 'bullmq';
import { BackupService, parseTarget } from './backup/backup-service';
import { parseKey } from './backup/crypto-stream';
import { S3ObjectStore, type ObjectStore } from './backup/object-store';
import { PgTools } from './backup/pg-tools';
import { DATA_QUEUE } from './backup/data-jobs';
import { DatabaseProvisioner } from './backup/provisioning';
import { SecretsCrypto } from './secrets/secrets-crypto';
import { SecretsService } from './secrets/secrets.service';

/** Used when object storage is not configured: every backup then FAILS LOUDLY (and alerts) instead of writing to a local disk. */
class UnconfiguredStore implements ObjectStore {
  private fail(): never { throw new Error('object storage is not configured (set S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY)'); }
  put(): Promise<void> { return this.fail(); }
  get(): Promise<never> { return this.fail(); }
  size(): Promise<never> { return this.fail(); }
  delete(): Promise<void> { return this.fail(); }
  list(): Promise<never> { return this.fail(); }
}

/** The audit log is written straight to the database (this process has no HTTP stack). Append-only via the table trigger. */
function auditTo(prisma: PrismaClient) {
  return {
    async record(e: { actorId?: string; actorName?: string; action: string; targetType?: string; targetId?: string; result: 'SUCCESS' | 'DENIED' | 'ERROR'; metadata?: Record<string, unknown> }) {
      try {
        await prisma.auditLogEntry.create({ data: { actorId: e.actorId ?? null, actorName: e.actorName ?? null, action: e.action, targetType: e.targetType, targetId: e.targetId, result: e.result, metadata: (e.metadata ?? undefined) as object | undefined } });
      } catch (err) {
        console.error(`audit write failed: ${(err as Error).message}`);
      }
    },
  };
}

/**
 * The data worker: backups, restores, restore drills and retention (PRD 6.7). Like the deployer it has no HTTP surface; it consumes a
 * queue. It holds the database credentials the API deliberately does not have (a read-only-everything backup role).
 */
async function main() {
  const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`Missing required environment variable ${k}`); return v; };
  const prisma = new PrismaClient();
  const store = S3ObjectStore.fromEnv();
  if (store && process.env.S3_ENSURE_BUCKET === 'true') {
    // local development store only; it may still be starting, so retry rather than crash-loop
    for (let i = 0; ; i++) {
      try { await store.ensureBucket(); break; } catch (e) { if (i >= 30) throw e; await new Promise((r) => setTimeout(r, 2000)); }
    }
  }
  if (!store) console.warn('Object storage is NOT configured: backups will fail and alert until S3_* is set.');

  const service = new BackupService(
    prisma, store ?? new UnconfiguredStore(), new PgTools(),
    {
      host: process.env.PG_HOST ?? 'postgres', port: Number(process.env.PG_PORT ?? 5432),
      user: process.env.BACKUP_DB_USER ?? 'aegis_backup', password: need('BACKUP_DB_PASSWORD'),
      systemDatabases: { aegisops: process.env.SYSTEM_DB_AEGISOPS ?? 'aegisops', keycloak: process.env.SYSTEM_DB_KEYCLOAK ?? 'keycloak' },
      encryptionKey: parseKey(need('BACKUP_ENCRYPTION_KEY')),
      rtoSeconds: Number(process.env.BACKUP_RTO_SECONDS ?? 4 * 3600),
      keyPrefix: process.env.S3_PREFIX ?? 'aegisops/',
      provisioner: { user: process.env.PROVISIONER_DB_USER ?? 'aegis_provisioner', password: need('PROVISIONER_DB_PASSWORD') },
    },
    auditTo(prisma),
  );
  // Provisioning stores the new database's connection string as an ENCRYPTED environment secret (the deployer injects it).
  const provisioner = new DatabaseProvisioner(
    prisma, new PgTools(), SecretsService.withCrypto(prisma as never, SecretsCrypto.fromEnv()),
    { host: process.env.PG_HOST ?? 'postgres', port: Number(process.env.PG_PORT ?? 5432), user: process.env.PROVISIONER_DB_USER ?? 'aegis_provisioner', password: need('PROVISIONER_DB_PASSWORD'), backupRole: process.env.BACKUP_DB_USER ?? 'aegis_backup' },
    auditTo(prisma),
  );

  // A backup or restore left RUNNING by a crashed worker can never finish; say so honestly.
  await prisma.backupJob.updateMany({ where: { status: 'RUNNING' }, data: { status: 'FAILED', error: 'data worker restarted mid-backup', finishedAt: new Date() } });
  await prisma.restoreJob.updateMany({ where: { status: 'RUNNING' }, data: { status: 'FAILED', error: 'data worker restarted mid-restore', finishedAt: new Date() } });
  await prisma.database.updateMany({ where: { status: 'PROVISIONING' }, data: { status: 'FAILED', error: 'data worker restarted while provisioning' } });
  await service.cleanupScratch().catch((e) => console.warn(`scratch cleanup skipped: ${e.message}`));

  const u = new URL(need('REDIS_URL'));
  const connection = { host: u.hostname, port: Number(u.port || 6379), password: decodeURIComponent(u.password) };

  // Schedules (UTC). Definitions are idempotent: restarting the worker never duplicates them.
  const queue = new Queue(DATA_QUEUE, { connection });
  await queue.upsertJobScheduler('nightly-backup', { pattern: process.env.BACKUP_CRON ?? '0 2 * * *', tz: 'UTC' }, { name: 'backup-all' });
  await queue.upsertJobScheduler('daily-prune', { pattern: process.env.PRUNE_CRON ?? '30 3 * * *', tz: 'UTC' }, { name: 'prune' });
  await queue.upsertJobScheduler('weekly-restore-drill', { pattern: process.env.DRILL_CRON ?? '0 4 * * 0', tz: 'UTC' }, { name: 'drill' });

  // concurrency 1: one heavy Postgres job at a time on a small droplet.
  const worker = new Worker(DATA_QUEUE, async (job) => {
    const d = job.data ?? {};
    switch (job.name) {
      case 'backup-all': return void (await service.backupAll('SCHEDULED'));
      case 'backup': return void (await service.backup(parseTarget(d.target), { kind: 'MANUAL', triggeredById: d.requestedById }));
      case 'restore': return void (await service.restoreToNew(d.backupJobId, { requestedById: d.requestedById, reason: d.reason }));
      case 'provision-db': return void (await provisioner.provision(d.databaseId, d.requestedById));
      case 'overwrite': return void (await service.overwrite(d.backupJobId, { requestedById: d.requestedById, reason: d.reason }));
      case 'drill': return void (await service.drill());
      case 'prune': return void (await service.prune());
      default: throw new Error(`unknown job ${job.name}`);
    }
  }, { connection, concurrency: 1 });
  worker.on('failed', (job, err) => console.error(`job ${job?.name} failed: ${err.message}`));
  console.log('data worker ready');

  const stop = async () => { await worker.close(); await queue.close(); await prisma.$disconnect(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((e) => { console.error(e); process.exit(1); });
