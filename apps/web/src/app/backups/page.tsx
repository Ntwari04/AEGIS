import { notFound, redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { api, ApiError } from '@/lib/api';
import { currentRoles } from '@/lib/permissions';
import { Time } from '@/app/time';
import { AutoRefresh } from '@/app/auto-refresh';

type Backup = { id: string; target: string; kind: string; status: string; sizeBytes: number | null; startedAt: string; finishedAt: string | null; error: string | null };
type Restore = { id: string; backupJobId: string; kind: string; status: string; targetDatabase: string; startedAt: string; durationMs: number | null; error: string | null; integrity: { ok: boolean | null; tables: number | null; rows: number | null; withinRto: boolean | null } | null };
type Overview = { rtoSeconds: number; targets: { target: string; last: Backup | null; lastSuccess: Backup | null; lastDrill: Restore | null }[]; recent: Backup[] };

const size = (n: number | null) => (n === null ? '—' : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} kB`);
const dur = (ms: number | null) => (ms === null ? '—' : ms < 1000 ? `${ms} ms` : ms < 120000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60000)} min`);
const age = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 90 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
const label = (t: string) => (t === 'system:aegisops' ? 'AegisOps database' : t === 'system:keycloak' ? 'Keycloak (users, roles, realm)' : t);

/** Backup & recovery health of the platform's own databases (FR-BACKUP-1..5): platform admins and auditors. */
export default async function BackupsPage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const roles = await currentRoles();
  if (!roles.includes('platform_admin') && !roles.includes('auditor')) notFound();
  const { error, ok } = await searchParams;
  const admin = roles.includes('platform_admin');
  const [o, restores] = await Promise.all([api<Overview>('/backups/overview'), api<Restore[]>('/restores?limit=15')]);

  async function call(path: string, done: string) {
    'use server';
    try {
      await api(path, { method: 'POST' }, { redirectOn401: false });
    } catch (e) {
      if (e instanceof ApiError) redirect(`/backups?error=${encodeURIComponent(e.message)}`);
      throw e;
    }
    revalidatePath('/backups');
    redirect(`/backups?ok=${encodeURIComponent(done)}`);
  }
  async function backupSystem(name: string) { 'use server'; await call(`/backups/system/${name}`, 'Backup queued.'); }
  async function drillNow() { 'use server'; await call('/backups/drill', 'Restore drill queued: every target is restored to a scratch database and verified.'); }

  const rtoMin = Math.round(o.rtoSeconds / 60);
  return (
    <>
      <AutoRefresh everyMs={20_000} />
      <div className="row">
        <h1>Backups &amp; recovery</h1>
        {admin && <form action={drillNow}><button data-testid="drill-now">Run restore drill now</button></form>}
      </div>
      {error && <p className="error" data-testid="page-error">{error}</p>}
      {ok && <p className="ok" data-testid="page-ok">{ok}</p>}
      <p className="note">Nightly backups are encrypted and stored off this server. A weekly drill restores every backup into a scratch database and compares exact row counts. Restore time objective: {rtoMin >= 60 ? `${rtoMin / 60} h` : `${rtoMin} min`}.</p>

      {o.targets.map((t) => (
        <div className="card" key={t.target} data-testid={`target-${t.target}`}>
          <div className="row">
            <strong>{label(t.target)}</strong>
            {admin && <form action={backupSystem.bind(null, t.target.replace('system:', ''))}><button className="link">Back up now</button></form>}
          </div>
          <table className="kv">
            <tbody>
              <tr>
                <th>Last backup</th>
                <td>
                  {t.last ? <><span className="status" data-status={t.last.status}>{t.last.status}</span> {age(t.last.startedAt)} · {size(t.last.sizeBytes)} · {t.last.kind.toLowerCase()}{t.last.error && <div className="error mono">{t.last.error}</div>}</> : <span className="error">never</span>}
                </td>
              </tr>
              <tr>
                <th>Last restore drill</th>
                <td>
                  {t.lastDrill ? (
                    <>
                      <span className="status" data-status={t.lastDrill.status}>{t.lastDrill.status}</span> {age(t.lastDrill.startedAt)} · took {dur(t.lastDrill.durationMs)}{' '}
                      {t.lastDrill.integrity?.ok && <span className="ok">· verified: {t.lastDrill.integrity.tables} tables, {t.lastDrill.integrity.rows} rows{t.lastDrill.integrity.withinRto === false ? '' : ' · within RTO'}</span>}
                      {t.lastDrill.integrity?.withinRto === false && <span className="error"> · OUTSIDE the RTO</span>}
                      {t.lastDrill.error && <div className="error mono">{t.lastDrill.error}</div>}
                    </>
                  ) : <span className="muted">no drill yet (weekly, Sundays 04:00 UTC)</span>}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      ))}

      <div className="card">
        <strong>Recent restores and drills</strong>
        {restores.length === 0 ? <p className="muted">None yet.</p> : (
          <table className="stack" data-testid="restore-history">
            <thead><tr><th>When</th><th>Kind</th><th>Status</th><th>Took</th><th>Integrity</th></tr></thead>
            <tbody>
              {restores.map((r) => (
                <tr key={r.id}>
                  <td data-label="When"><Time iso={r.startedAt} /></td>
                  <td className="muted" data-label="Kind">{r.kind}</td>
                  <td data-label="Status"><span className="status" data-status={r.status}>{r.status}</span>{r.error && <div className="error mono">{r.error}</div>}</td>
                  <td className="mono" data-label="Took">{dur(r.durationMs)}</td>
                  <td data-label="Integrity">{r.integrity ? (r.integrity.ok ? <span className="ok">{r.integrity.tables} tables, {r.integrity.rows} rows</span> : <span className="error">mismatch</span>) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
