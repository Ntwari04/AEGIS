import { SWAP_SQL } from './backup-service';
import { CLEANUP_SQL, PROVISION_SQL } from './provisioning';

// In a TypeScript template literal a lone backslash before "g" silently becomes "g" (no error). These scripts are executed by psql,
// whose meta-commands (\gexec, \g) need a REAL backslash, so the evaluated strings are asserted here.
describe('psql scripts survive template-literal escaping', () => {
  const scripts: [string, string][] = [['provision', PROVISION_SQL], ['cleanup', CLEANUP_SQL], ['swap', SWAP_SQL]];

  it.each(scripts)('%s: every statement that needs a meta-command has a real backslash', (_name, sql) => {
    const lines = sql.split('\n').filter((l) => l.trim());
    for (const l of lines) expect(l.trimEnd()).toMatch(/\\g(exec)?( \/dev\/null)?$/);
  });

  it('the guard itself works: a bare "gexec" (the escaping bug) is rejected, a real "\\gexec" is accepted', () => {
    const guard = /\\g(exec)?( \/dev\/null)?$/;
    expect(guard.test("SELECT 1 gexec")).toBe(false);
    expect(guard.test("SELECT 1 \\gexec")).toBe(true);
    expect(guard.test("SELECT 1 \\g /dev/null")).toBe(true);
    expect(guard.test("SELECT 1 g /dev/null")).toBe(false);
  });

  it('values reach SQL as psql variables formatted with %I / %L, never spliced in', () => {
    for (const [, sql] of scripts) {
      expect(sql).not.toMatch(/\$\{/);
      expect(sql).toMatch(/:'(role|db|old|staging|pw|backup)'/);
    }
    expect(PROVISION_SQL).toContain("PASSWORD %L");
    expect(PROVISION_SQL).toContain('NOSUPERUSER NOCREATEDB NOCREATEROLE');
    expect(PROVISION_SQL).toContain('REVOKE ALL ON DATABASE %I FROM PUBLIC');
  });

  it('the swap closes connections before renaming, so the application cannot reconnect in between', () => {
    const iAllow = SWAP_SQL.indexOf('ALLOW_CONNECTIONS false');
    const iKill = SWAP_SQL.indexOf('pg_terminate_backend');
    const iRename = SWAP_SQL.indexOf('RENAME TO');
    expect(iAllow).toBeGreaterThan(-1);
    expect(iAllow).toBeLessThan(iKill);
    expect(iKill).toBeLessThan(iRename);
  });
});
