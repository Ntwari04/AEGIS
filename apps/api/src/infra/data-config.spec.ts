import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const root = join(__dirname, '../../../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const compose = parse(read('infra/docker-compose.yml')) as { services: Record<string, any> };
const local = parse(read('infra/docker-compose.local-s3.yml')) as { services: Record<string, any> };
const localHttps = parse(read('infra/docker-compose.local-https.yml')) as { services: Record<string, any> };

describe('backup & database management configuration (Phase 5)', () => {
  const w = compose.services['data-worker'];

  it('the data worker has no port, no Docker socket, no capabilities, a read-only filesystem and a memory cap', () => {
    expect(w).toBeDefined();
    expect(w.ports).toBeUndefined();
    expect(JSON.stringify(w.volumes ?? [])).not.toContain('docker.sock');
    expect(w.cap_drop).toContain('ALL');
    expect(w.read_only).toBe(true);
    expect(w.mem_limit).toBeTruthy();
    expect(w.networks).toContain('aegisops-net');
  });

  it('every credential the worker uses comes from the environment file, and the encryption key is mandatory', () => {
    const env = w.environment;
    expect(env.BACKUP_DB_PASSWORD).toContain('${AEGIS_BACKUP_DB_PASSWORD:?');
    expect(env.BACKUP_ENCRYPTION_KEY).toContain('${BACKUP_ENCRYPTION_KEY:?'); // refuses to start without it
    expect(env.S3_SECRET_ACCESS_KEY).toContain('${S3_SECRET_ACCESS_KEY');
    expect(env.S3_ACCESS_KEY_ID).toContain('${S3_ACCESS_KEY_ID');
    expect(env.DATABASE_URL).toContain('${AEGISOPS_DB_PASSWORD}');
  });

  it('the API never receives the backup role, the backup key or object-storage credentials', () => {
    const api = JSON.stringify(compose.services.api.environment);
    for (const k of ['BACKUP_', 'AEGIS_BACKUP', 'S3_', 'PROVISIONER']) expect(api).not.toContain(k);
    const web = JSON.stringify(compose.services.web.environment);
    for (const k of ['BACKUP_', 'S3_']) expect(web).not.toContain(k);
  });

  it('the anonymous local S3 store exists ONLY in the local override, never in the production compose file', () => {
    expect(compose.services['s3-local']).toBeUndefined();
    expect(local.services['s3-local']).toBeDefined();
    expect(local.services['s3-local'].ports).toBeUndefined();
    expect(local.services['s3-local'].image).toMatch(/:\d[\w.-]*$/); // pinned
    expect(JSON.stringify(compose)).not.toContain('S3_ENSURE_BUCKET');
  });

  it('the usual local override does NOT swap in the throwaway store: backups use the real bucket unless the s3 file is added', () => {
    expect(localHttps.services['s3-local']).toBeUndefined();
    expect(JSON.stringify(localHttps.services['data-worker'] ?? {})).not.toContain('S3_');
  });

  it('Postgres receives only the two role passwords it needs to create the data roles', () => {
    const env = compose.services.postgres.environment;
    expect(env.AEGIS_BACKUP_DB_PASSWORD).toContain('${');
    expect(env.AEGIS_PROVISIONER_DB_PASSWORD).toContain('${');
  });

  it('the data roles are least-privilege: no superuser, passwords only as psql variables', () => {
    const sh = read('infra/postgres/init/02-data-roles.sh');
    expect(sh).not.toMatch(/\bSUPERUSER\b(?<!NOSUPERUSER)/);
    expect((sh.match(/NOSUPERUSER/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(sh).toContain('pg_read_all_data');
    expect(sh).toContain("createrole_self_grant");
    expect(sh).toMatch(/:'bk_pw'/);
    expect(sh).toMatch(/:'pv_pw'/);
    expect(sh).not.toMatch(/PASSWORD '[A-Za-z0-9]/); // no literal password
  });

  it('the runtime image ships pg_dump 16 to match the Postgres 16 server', () => {
    expect(read('apps/api/Dockerfile')).toContain('postgresql16-client');
    expect(compose.services.postgres.image).toContain('postgres:16');
  });

  it('the backup encryption key and storage secrets are placeholders in the example file, never real values', () => {
    const ex = read('infra/.env.example');
    for (const k of ['AEGIS_BACKUP_DB_PASSWORD', 'AEGIS_PROVISIONER_DB_PASSWORD', 'BACKUP_ENCRYPTION_KEY', 'S3_SECRET_ACCESS_KEY']) {
      expect(ex).toMatch(new RegExp(`^${k}=CHANGE_ME$`, 'm'));
    }
  });
});
