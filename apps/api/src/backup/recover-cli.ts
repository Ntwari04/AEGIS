import { parseKey } from './crypto-stream';
import { S3ObjectStore } from './object-store';
import { PgTools } from './pg-tools';
import { listArchives, recover, type SystemTarget } from './recover';

/**
 * Disaster recovery when the AegisOps database itself is gone. Runs from any container that has this image and can reach the
 * bucket and an EMPTY Postgres database. Secrets come only from the environment, never from arguments:
 *
 *   S3_ENDPOINT S3_REGION S3_BUCKET S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY   where the backups are
 *   BACKUP_ENCRYPTION_KEY                                                    the key kept OFF the server
 *   RECOVER_DB_HOST RECOVER_DB_PORT RECOVER_DB_USER RECOVER_DB_PASSWORD      where to restore to
 *
 *   node dist/backup/recover-cli.js list
 *   node dist/backup/recover-cli.js restore --target keycloak --database keycloak
 *   node dist/backup/recover-cli.js restore --target aegisops --database aegisops [--object <key>] [--allow-non-empty]
 */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const TARGETS: SystemTarget[] = ['aegisops', 'keycloak'];

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const store = S3ObjectStore.fromEnv();
  if (!store) throw new Error('object storage is not configured (S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY)');
  const prefix = process.env.S3_PREFIX ?? 'aegisops/';

  if (cmd === 'list') {
    for (const t of TARGETS) {
      const all = await listArchives(store, prefix, t);
      console.log(`${t}: ${all.length} archive(s)`);
      for (const a of all.slice(-5)) console.log(`  ${a.key}  ${a.size} bytes`);
    }
    return;
  }

  if (cmd === 'restore') {
    const target = flag(args, 'target') as SystemTarget | undefined;
    const database = flag(args, 'database');
    if (!target || !TARGETS.includes(target) || !database || !/^[a-z0-9_]{1,63}$/.test(database)) {
      throw new Error('usage: restore --target aegisops|keycloak --database <empty database name> [--object <key>] [--allow-non-empty]');
    }
    const need = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`Missing required environment variable ${k}`); return v; };
    const result = await recover(
      store, new PgTools(),
      {
        target, prefix, objectKey: flag(args, 'object'), allowNonEmpty: args.includes('--allow-non-empty'),
        encryptionKey: parseKey(need('BACKUP_ENCRYPTION_KEY')),
        into: { host: need('RECOVER_DB_HOST'), port: Number(process.env.RECOVER_DB_PORT ?? 5432), user: need('RECOVER_DB_USER'), password: need('RECOVER_DB_PASSWORD'), database },
      },
      (line) => console.log(line),
    );
    console.log(`restored ${result.tables} tables, ${result.rows} rows into "${database}" in ${result.seconds.toFixed(1)} s`);
    return;
  }

  throw new Error('usage: recover-cli.js list | restore --target aegisops|keycloak --database <name>');
}

main().catch((e) => { console.error(`FAILED: ${(e as Error).message}`); process.exit(1); });
