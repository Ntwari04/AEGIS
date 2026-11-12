import Link from 'next/link';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { api, ApiError } from '@/lib/api';
import type { EnvironmentDto, Role } from '@aegisops/shared-types';

type Db = { id: string; name: string; environmentId: string | null; status: 'PROVISIONING' | 'READY' | 'FAILED' | string; error: string | null; createdAt: string };

const STATUS_COLOR: Record<string, string> = { READY: 'SUCCESS', PROVISIONING: 'RUNNING', FAILED: 'FAILED' };

/** Databases of a project (FR-DB-1). Provisioning is queued; the page refreshes itself while one is being created. */
export async function DatabasesCard({ projectId, environments, roles }: { projectId: string; environments: EnvironmentDto[]; roles: Role[] }) {
  const dbs = await api<Db[]>(`/projects/${encodeURIComponent(projectId)}/databases`).catch(() => [] as Db[]);
  const isPrivileged = roles.includes('platform_admin') || roles.includes('devops_engineer');
  const canSeeBackups = isPrivileged || roles.includes('auditor');
  const busy = dbs.some((d) => d.status === 'PROVISIONING');
  const free = environments.filter((e) => !dbs.some((d) => d.environmentId === e.id && d.status !== 'FAILED'));

  async function provision(formData: FormData) {
    'use server';
    try {
      await api(`/projects/${encodeURIComponent(projectId)}/databases`, {
        method: 'POST',
        body: JSON.stringify({ name: String(formData.get('name') ?? '').trim(), environmentId: String(formData.get('environmentId') ?? '') }),
      }, { redirectOn401: false });
    } catch (e) {
      if (e instanceof ApiError) redirect(`/projects/${projectId}?error=${encodeURIComponent(e.message)}`);
      throw e;
    }
    revalidatePath(`/projects/${projectId}`);
    redirect(`/projects/${projectId}`);
  }

  return (
    <div className="card" id="databases" data-testid="databases-card">
      {busy && <meta httpEquiv="refresh" content="3" />}
      <strong>Databases</strong>{' '}
      <span className="muted">(each gets its own PostgreSQL role; the connection string is stored encrypted as the environment secret DATABASE_URL)</span>
      {dbs.length === 0 ? (
        <p className="muted">No databases yet.</p>
      ) : (
        <table className="stack">
          <thead><tr><th>Name</th><th>Environment</th><th>Status</th><th /></tr></thead>
          <tbody>
            {dbs.map((d) => (
              <tr key={d.id} data-testid={`db-${d.name}`}>
                <td className="mono" data-label="Name">{d.name}</td>
                <td data-label="Environment">{environments.find((e) => e.id === d.environmentId)?.name ?? '—'}</td>
                <td data-label="Status">
                  <span className="status" data-status={STATUS_COLOR[d.status] ?? 'PENDING'}>{d.status}</span>
                  {d.error && <div className="error mono">{d.error}</div>}
                </td>
                <td>{d.status === 'READY' && canSeeBackups && <Link href={`/projects/${projectId}/databases/${d.id}`}>Backups</Link>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {isPrivileged && free.length > 0 && (
        <details className="fold" open={dbs.length === 0}>
          <summary>Provision a database</summary>
          <form action={provision} className="inline">
            <div><label htmlFor="db-name">Name</label><input id="db-name" name="name" required pattern="[a-z0-9]([a-z0-9\-]{0,38}[a-z0-9])?" placeholder="orders" /></div>
            <div>
              <label htmlFor="db-env">Environment</label>
              <select id="db-env" name="environmentId" required>
                {free.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
              </select>
            </div>
            <button data-testid="provision-db">Provision database</button>
          </form>
        </details>
      )}
    </div>
  );
}
