import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { api, ApiError } from '@/lib/api';
import { Time } from '@/app/time';
import { AutoRefresh } from '@/app/auto-refresh';
import { currentRoles, isPrivileged } from '@/lib/permissions';

type Backup = { id: string; kind: string; status: string; sizeBytes: number | null; startedAt: string; finishedAt: string | null; error: string | null; expired: boolean };
type Restore = { id: string; backupJobId: string; kind: string; status: string; targetDatabase: string; startedAt: string; durationMs: number | null; error: string | null; reason: string | null; integrity: { ok: boolean | null; tables: number | null; rows: number | null; withinRto: boolean | null; previousDatabase: string | null } | null };
type Db = { id: string; name: string; status: string };

const size = (n: number | null) => (n === null ? '—' : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} kB`);
const dur = (ms: number | null) => (ms === null ? '—' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

export default async function DatabasePage({ params, searchParams }: { params: Promise<{ id: string; dbId: string }>; searchParams: Promise<{ error?: string; ok?: string }> }) {
  const { id, dbId } = await params;
  const { error, ok } = await searchParams;
  const roles = await currentRoles();
  const here = `/projects/${id}/databases/${dbId}`;
  const base = `/projects/${encodeURIComponent(id)}/databases/${encodeURIComponent(dbId)}`;

  const dbs = await api<Db[]>(`/projects/${encodeURIComponent(id)}/databases`).catch(() => null);
  const db = dbs?.find((d) => d.id === dbId);
  if (!db) notFound();
  let data: { backups: Backup[]; restores: Restore[] };
  try {
    data = await api(`${base}/backups`);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 403 || e.status === 404)) notFound();
    throw e;
  }
  const mayAct = isPrivileged(roles);
  const mayOverwrite = roles.includes('platform_admin');
  const running = data.backups.some((b) => b.status === 'RUNNING' || b.status === 'PENDING') || data.restores.some((r) => r.status === 'RUNNING');

  /** Every action is queued and reported back on this page; errors come back as a message, never as a crash. */
  async function act(path: string, body: unknown, done: string) {
    'use server';
    try {
      await api(`${base}${path}`, { method: 'POST', body: JSON.stringify(body ?? {}) }, { redirectOn401: false });
    } catch (e) {
      if (e instanceof ApiError) redirect(`${here}?error=${encodeURIComponent(e.message)}`);
      throw e;
    }
    revalidatePath(here);
    redirect(`${here}?ok=${encodeURIComponent(done)}`);
  }
  async function backupNow() { 'use server'; await act('/backups', {}, 'Backup queued.'); }
  async function restore(backupId: string, formData: FormData) {
    'use server';
    await act(`/backups/${encodeURIComponent(backupId)}/restore`, { reason: String(formData.get('reason') ?? '').trim() }, 'Restore into a NEW database queued. The live database is untouched.');
  }
  async function overwrite(backupId: string, formData: FormData) {
    'use server';
    await act(`/backups/${encodeURIComponent(backupId)}/overwrite`, { confirm: String(formData.get('confirm') ?? ''), reason: String(formData.get('reason') ?? '').trim() },
      'Overwrite queued: a safety backup is taken first, then the restore is verified before it replaces the live database.');
  }

  return (
    <>
      <AutoRefresh everyMs={running ? 3_000 : 30_000} />
      <p><Link href={`/projects/${id}`}>← Back to project</Link></p>
      <h1>Database <span className="mono">{db.name}</span></h1>
      {error && <p className="error" data-testid="page-error">{error}</p>}
      {ok && <p className="ok" data-testid="page-ok">{ok}</p>}

      <div className="card">
        <div className="row">
          <strong>Backups</strong>
          {mayAct && <form action={backupNow}><button data-testid="backup-now">Back up now</button></form>}
        </div>
        <p className="note">Nightly backups run automatically (encrypted, stored off this server). Manual backups are kept 30 days.</p>
        {data.backups.length === 0 ? <p className="muted">No backups yet.</p> : (
          <table className="stack" data-testid="backup-history">
            <thead><tr><th>When</th><th>Kind</th><th>Status</th><th>Size</th><th /></tr></thead>
            <tbody>
              {data.backups.map((b) => (
                <tr key={b.id}>
                  <td data-label="When"><Time iso={b.startedAt} /></td>
                  <td className="muted" data-label="Kind">{b.kind}</td>
                  <td>
                    <span className="status" data-status={b.status}>{b.status}</span>
                    {b.expired && <span className="muted"> expired</span>}
                    {b.error && <div className="error mono">{b.error}</div>}
                  </td>
                  <td className="mono">{size(b.sizeBytes)}</td>
                  <td>
                    {mayAct && b.status === 'SUCCESS' && !b.expired && (
                      <details>
                        <summary>Restore…</summary>
                        <form action={restore.bind(null, b.id)} className="inline" style={{ marginTop: 8 }}>
                          <div><label htmlFor={`r-${b.id}`}>Reason (optional)</label><input id={`r-${b.id}`} name="reason" maxLength={500} /></div>
                          <button data-testid="restore-new">Restore to a NEW database</button>
                        </form>
                        <p className="note">Creates a separate database, verified against the backup. The live database is not touched.</p>
                        {mayOverwrite && (
                          <form action={overwrite.bind(null, b.id)} className="card danger" style={{ marginTop: 8 }}>
                            <strong>Overwrite the LIVE database</strong>
                            <p className="note">Takes a safety backup of the current data first, restores this backup into a new database and verifies it, then swaps. The previous data is kept as <span className="mono">{db.name}</span>_old_&lt;time&gt;.</p>
                            <label htmlFor={`oc-${b.id}`}>Type the database name <span className="mono">{db.name}</span> to confirm</label>
                            <input id={`oc-${b.id}`} name="confirm" required autoComplete="off" />
                            <label htmlFor={`or-${b.id}`}>Reason (recorded in the audit log, at least 10 characters)</label>
                            <input id={`or-${b.id}`} name="reason" required minLength={10} maxLength={500} />
                            <button data-testid="overwrite">Overwrite live database</button>
                          </form>
                        )}
                      </details>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <strong>Restores</strong>
        {data.restores.length === 0 ? <p className="muted">No restores yet.</p> : (
          <table className="stack" data-testid="restore-history">
            <thead><tr><th>When</th><th>Kind</th><th>Status</th><th>Into</th><th>Took</th><th>Integrity</th></tr></thead>
            <tbody>
              {data.restores.map((r) => (
                <tr key={r.id}>
                  <td data-label="When"><Time iso={r.startedAt} /></td>
                  <td className="muted" data-label="Kind">{r.kind}</td>
                  <td><span className="status" data-status={r.status}>{r.status}</span>{r.error && <div className="error mono">{r.error}</div>}</td>
                  <td className="mono" data-label="Into">{r.integrity?.previousDatabase ? `${db.name} (old: ${r.integrity.previousDatabase})` : r.targetDatabase}</td>
                  <td className="mono" data-label="Took">{dur(r.durationMs)}</td>
                  <td data-label="Integrity">{r.integrity ? (r.integrity.ok ? <span className="ok">verified: {r.integrity.tables} tables, {r.integrity.rows} rows</span> : <span className="error">mismatch</span>) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
