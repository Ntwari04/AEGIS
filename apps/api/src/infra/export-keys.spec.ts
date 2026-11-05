import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = join(__dirname, '../../../../infra/scripts/export-keys.mjs');
const backup = randomBytes(32).toString('base64');
const secrets = randomBytes(32).toString('base64');

function envFile(content = `BACKUP_ENCRYPTION_KEY=${backup}\nSECRETS_ENCRYPTION_KEY=${secrets}\n`) {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-keys-'));
  writeFileSync(join(dir, '.env'), content);
  return join(dir, '.env');
}
const run = (args: string[], env: string, input?: string) => {
  const r = spawnSync('node', [script, '--env', env, ...args], { encoding: 'utf8', input });
  return { code: r.status, out: r.stdout + r.stderr };
};

describe('infra/scripts/export-keys.mjs', () => {
  it('prints fingerprints by default and never a key', () => {
    const r = run([], envFile());
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/BACKUP_ENCRYPTION_KEY +[0-9a-f]{12}/);
    expect(r.out).not.toContain(backup);
    expect(r.out).not.toContain(secrets);
  });

  it('--reveal refuses to print when stdout is not a terminal, and prints no key', () => {
    const r = run(['--reveal'], envFile());
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/only prints to an interactive terminal/);
    expect(r.out).not.toContain(backup);
  });

  it('--verify says MATCH for a correct copy (with stray whitespace) and MISMATCH for a wrong one, printing neither value', () => {
    const env = envFile();
    const ok = run(['--verify', 'BACKUP_ENCRYPTION_KEY'], env, `  ${backup}\n`);
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/MATCH/);
    const wrong = run(['--verify', 'BACKUP_ENCRYPTION_KEY'], env, secrets);
    expect(wrong.code).toBe(1);
    expect(wrong.out).toMatch(/MISMATCH/);
    expect(ok.out + wrong.out).not.toContain(backup);
    expect(ok.out + wrong.out).not.toContain(secrets);
  });

  it('fails clearly when a key is missing, and rejects an unknown name', () => {
    expect(run([], envFile(`BACKUP_ENCRYPTION_KEY=${backup}\n`)).out).toMatch(/SECRETS_ENCRYPTION_KEY is missing/);
    expect(run(['--verify', 'AUTH_SECRET'], envFile(), 'x').out).toMatch(/takes one of/);
  });
});
