import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { decryptStream } from './crypto-stream';
import type { ObjectStore } from './object-store';
import type { PgConn, PgTools, TableCounts } from './pg-tools';

export type SystemTarget = 'aegisops' | 'keycloak';

export interface RecoverOptions {
  target: SystemTarget;
  /** Storage prefix of the installation, normally "aegisops/". */
  prefix: string;
  /** Restore this exact archive instead of the newest one. */
  objectKey?: string;
  /** The (empty) database to restore into. It must already exist. */
  into: PgConn;
  encryptionKey: Buffer;
  /** Refuse a database that already has tables, unless the operator says otherwise. */
  allowNonEmpty?: boolean;
}

export interface RecoverResult {
  objectKey: string;
  tables: number;
  rows: number;
  seconds: number;
  counts: TableCounts;
}

const systemPrefix = (prefix: string, target: SystemTarget) => `${prefix}system/${target}/`;

/** Every archive of a system target, newest last. Keys carry a UTC timestamp, so sorting by key is sorting by time. */
export async function listArchives(store: ObjectStore, prefix: string, target: SystemTarget) {
  const items = await store.list(systemPrefix(prefix, target));
  return items.filter((o) => o.key.endsWith('.sql.gz.enc')).sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Disaster recovery without the AegisOps database: it needs only the bucket, the backup key and an empty database.
 * No record is read, so it works when the thing that holds the records is the thing that was lost.
 * Authentication is per chunk, so a damaged or tampered archive stops before it can apply anything past the damage,
 * and the dump is applied in ONE transaction: it either all applies or nothing does.
 */
export async function recover(store: ObjectStore, pg: PgTools, opts: RecoverOptions, log: (line: string) => void = () => undefined): Promise<RecoverResult> {
  const started = Date.now();
  let objectKey = opts.objectKey;
  if (!objectKey) {
    const all = await listArchives(store, opts.prefix, opts.target);
    if (all.length === 0) throw new Error(`no ${opts.target} backups found under ${systemPrefix(opts.prefix, opts.target)} (wrong bucket, prefix or credentials?)`);
    objectKey = all[all.length - 1].key;
  } else if (!objectKey.startsWith(systemPrefix(opts.prefix, opts.target))) {
    throw new Error(`that object is not a ${opts.target} backup of this installation`);
  }
  log(`archive: ${objectKey}`);

  const existing = Object.keys(await pg.countRows(opts.into));
  if (existing.length > 0 && !opts.allowNonEmpty) {
    throw new Error(`the target database "${opts.into.database}" already has ${existing.length} table(s); recover into an empty database (or pass --allow-non-empty)`);
  }

  const restore = pg.restore(opts.into);
  await Promise.all([
    pipeline(await store.get(objectKey), decryptStream(opts.encryptionKey), createGunzip(), restore.stdin),
    restore.done,
  ]);

  const counts = await pg.countRows(opts.into);
  return {
    objectKey,
    tables: Object.keys(counts).length,
    rows: Object.values(counts).reduce((a, b) => a + b, 0),
    seconds: (Date.now() - started) / 1000,
    counts,
  };
}
