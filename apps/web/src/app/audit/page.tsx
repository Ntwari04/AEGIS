import Link from 'next/link';
import { notFound } from 'next/navigation';
import { api } from '@/lib/api';
import { auditQuery, pickFilters, type AuditFilters } from '@/lib/audit-filters';
import { currentRoles } from '@/lib/permissions';

type Entry = {
  id: string; createdAt: string; actorName: string | null; action: string; result: 'SUCCESS' | 'DENIED' | 'ERROR';
  targetType: string | null; targetId: string | null; sourceIp: string | null; metadata: unknown;
};
type Page = { items: Entry[]; total: number; page: number; pageSize: number };

const PAGE_SIZE = 50;
const STATUS: Record<Entry['result'], string> = { SUCCESS: 'SUCCESS', DENIED: 'FAILED', ERROR: 'FAILED' };

/** Short, readable form of the details column; the full value is in the CSV export. */
function details(m: unknown): string {
  if (m === null || m === undefined) return '';
  const s = JSON.stringify(m);
  return s.length > 140 ? `${s.slice(0, 140)}…` : s;
}

/** FR-AUDIT-3: search, filter and export the audit log. Read-only; platform admins and auditors only (the API enforces it too). */
export default async function AuditPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const roles = await currentRoles();
  if (!roles.includes('platform_admin') && !roles.includes('auditor')) notFound();

  const raw = await searchParams;
  const filters: AuditFilters = pickFilters(raw);
  const page = Math.max(1, Number(typeof raw.page === 'string' ? raw.page : 1) || 1);
  const data = await api<Page>(`/audit-log?${auditQuery(filters, { page: String(page), pageSize: String(PAGE_SIZE) })}`);

  const link = (p: number) => `/audit?${new URLSearchParams({ ...filters, page: String(p) }).toString()}`;
  const exportHref = `/audit/export?${new URLSearchParams(filters).toString()}`;
  const pages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));

  return (
    <>
      <div className="row">
        <h1>Audit log</h1>
        <a className="btn" href={exportHref} data-testid="audit-export">Export CSV</a>
      </div>
      <p className="note">
        Every sign-in problem, denied request and change to a project, environment, deployment, backup, server or key is recorded here and cannot be edited or deleted.
        Exporting is recorded too, and returns the newest 10,000 matching entries.
      </p>

      <form method="get" action="/audit" className="card">
        <div className="grid2">
          <div><label htmlFor="f-action">Action (use <span className="mono">authz.*</span> for a prefix)</label><input id="f-action" name="action" defaultValue={filters.action} placeholder="project.create" /></div>
          <div><label htmlFor="f-actor">Who (part of the username)</label><input id="f-actor" name="actor" defaultValue={filters.actor} /></div>
          <div>
            <label htmlFor="f-result">Result</label>
            <select id="f-result" name="result" defaultValue={filters.result ?? ''}>
              <option value="">Any</option><option value="SUCCESS">Success</option><option value="DENIED">Denied</option><option value="ERROR">Error</option>
            </select>
          </div>
          <div className="inline">
            <div><label htmlFor="f-from">From</label><input id="f-from" name="from" type="date" defaultValue={filters.from?.slice(0, 10)} /></div>
            <div><label htmlFor="f-to">To (inclusive)</label><input id="f-to" name="to" type="date" defaultValue={filters.to?.slice(0, 10)} /></div>
          </div>
        </div>
        <div className="inline">
          <button data-testid="audit-search">Search</button>
          <Link href="/audit">Clear</Link>
        </div>
      </form>

      <p className="muted" data-testid="audit-total">{data.total.toLocaleString()} matching entr{data.total === 1 ? 'y' : 'ies'}</p>
      {data.items.length === 0 ? (
        <div className="card"><p className="muted" data-testid="audit-empty">Nothing matches these filters.</p></div>
      ) : (
        <table data-testid="audit-table">
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Result</th><th>Target</th><th>From</th><th>Details</th></tr></thead>
          <tbody>
            {data.items.map((e) => (
              <tr key={e.id} data-testid="audit-row">
                <td className="muted">{new Date(e.createdAt).toLocaleString()}</td>
                <td>{e.actorName ?? <span className="muted">system</span>}</td>
                <td className="mono">{e.action}</td>
                <td><span className="status" data-status={STATUS[e.result]}>{e.result}</span></td>
                <td className="mono">{e.targetType ? `${e.targetType}${e.targetId ? ` ${e.targetId.slice(0, 8)}` : ''}` : ''}</td>
                <td className="mono muted">{e.sourceIp ?? ''}</td>
                <td className="mono muted">{details(e.metadata)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {pages > 1 && (
        <p className="inline">
          {page > 1 && <Link href={link(page - 1)} data-testid="audit-prev">← Newer</Link>}
          <span className="muted">Page {page} of {pages}</span>
          {page < pages && <Link href={link(page + 1)} data-testid="audit-next">Older →</Link>}
        </p>
      )}
    </>
  );
}
