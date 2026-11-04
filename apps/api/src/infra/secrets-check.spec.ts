import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(__dirname, '../../../..');
const script = join(root, 'infra/scripts/check-secrets.mjs');
const key = () => randomBytes(32).toString('base64');
const pw = () => randomBytes(24).toString('base64url');

function run(env: string, example = 'A_PASSWORD=CHANGE_ME\nB_SECRET=CHANGE_ME\nSOME_KEY=CHANGE_ME\nOPTIONAL_TOKEN=\nBACKUP_ENCRYPTION_KEY=CHANGE_ME\nGHCR_TOKEN=CHANGE_ME\n') {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-secrets-'));
  // A real .env is chmod 600; fixtures must be too, or the audit (correctly) fails them on Linux.
  writeFileSync(join(dir, '.env'), env, { mode: 0o600 });
  chmodSync(join(dir, '.env'), 0o600);
  writeFileSync(join(dir, '.env.example'), example);
  const r = spawnSync('node', [script, '--env', join(dir, '.env'), '--example', join(dir, '.env.example')], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

describe('infra/scripts/check-secrets.mjs', () => {
  const good = `A_PASSWORD=${pw()}\nB_SECRET=${pw()}\nSOME_KEY=${pw()}\nBACKUP_ENCRYPTION_KEY=${key()}\n`;

  it('passes a healthy file and never prints any value', () => {
    const r = run(good);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/OK: \d+ secret/);
    for (const line of good.split('\n').filter(Boolean)) expect(r.out).not.toContain(line.split('=')[1]);
  });

  it('fails on a missing secret, a CHANGE_ME placeholder and an empty value, naming the variable but not guessing a value', () => {
    const r = run(`A_PASSWORD=CHANGE_ME\nB_SECRET=\nBACKUP_ENCRYPTION_KEY=${key()}\n`);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAIL +A_PASSWORD: still the CHANGE_ME placeholder/);
    expect(r.out).toMatch(/FAIL +B_SECRET: missing or empty/);
    expect(r.out).toMatch(/FAIL +SOME_KEY: missing or empty/);
  });

  it('fails when two different secrets share one value, without printing it', () => {
    const shared = pw();
    const r = run(`A_PASSWORD=${shared}\nB_SECRET=${shared}\nSOME_KEY=${pw()}\nBACKUP_ENCRYPTION_KEY=${key()}\n`);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAIL +A_PASSWORD, B_SECRET: share the SAME value/);
    expect(r.out).not.toContain(shared);
  });

  it('fails an encryption key that is not a 32-byte base64 key, and a common password', () => {
    const r = run(`A_PASSWORD=Password123456789012\nB_SECRET=${pw()}\nSOME_KEY=${pw()}\nBACKUP_ENCRYPTION_KEY=${Buffer.alloc(16).toString('base64')}\n`);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAIL +BACKUP_ENCRYPTION_KEY: is not a base64-encoded 32-byte key/);
    expect(r.out).toMatch(/FAIL +A_PASSWORD: looks like a placeholder or common password/);
  });

  it('only warns (does not fail) for short values and for optional secrets that are not set yet', () => {
    const r = run(`A_PASSWORD=shortone\nB_SECRET=${pw()}\nSOME_KEY=${pw()}\nBACKUP_ENCRYPTION_KEY=${key()}\n`);
    expect(r.out).toMatch(/WARN +A_PASSWORD: is short/);
    expect(r.out).toMatch(/WARN +GHCR_TOKEN: not set \(optional/);
    expect(r.code).toBe(0);
  });

  // POSIX only: Windows has no such mode bits. CI (Linux) runs this one.
  (process.platform === 'win32' ? it.skip : it)('fails a .env that other users can read, and tells you the fix', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aegis-secrets-'));
    writeFileSync(join(dir, '.env'), good, { mode: 0o644 });
    chmodSync(join(dir, '.env'), 0o644);
    writeFileSync(join(dir, '.env.example'), 'A_PASSWORD=CHANGE_ME\n');
    const r = spawnSync('node', [script, '--env', join(dir, '.env'), '--example', join(dir, '.env.example')], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/FAIL +\.env: is readable by other users/);
    expect(r.stdout).toContain('chmod 600');
  });

  it('fails clearly when the file does not exist', () => {
    const r = spawnSync('node', [script, '--env', join(tmpdir(), 'definitely-not-here', '.env')], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/not found/);
  });

  it('the real example file declares every Phase 5 secret as a placeholder, so a fresh install is told to set them', () => {
    const r = run('', require('node:fs').readFileSync(join(root, 'infra/.env.example'), 'utf8'));
    for (const name of ['AEGIS_BACKUP_DB_PASSWORD', 'AEGIS_PROVISIONER_DB_PASSWORD', 'BACKUP_ENCRYPTION_KEY', 'SECRETS_ENCRYPTION_KEY', 'GRAFANA_OAUTH_SECRET']) {
      expect(r.out).toMatch(new RegExp(`FAIL +${name}:`));
    }
  });
});
