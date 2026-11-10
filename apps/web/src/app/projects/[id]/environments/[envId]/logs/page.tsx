import Link from 'next/link';
import { notFound } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { LiveLogs } from './live-logs';

type Line = { ts: string; line: string; container: string };

/** Recent container logs of ONE environment (FR-INFRA-2), from Loki through the API, which binds the query to this project. */
export default async function LogsPage({
  params, searchParams,
}: { params: Promise<{ id: string; envId: string }>; searchParams: Promise<{ q?: string; minutes?: string }> }) {
  const { id, envId } = await params;
  const { q = '', minutes = '60' } = await searchParams;
  const mins = [15, 60, 360, 1440].includes(Number(minutes)) ? Number(minutes) : 60;
  const qs = new URLSearchParams({ minutes: String(mins), limit: '300', ...(q ? { q: q.slice(0, 100) } : {}) });
  let lines: Line[] = [];
  let problem: string | null = null;
  try {
    lines = (await api<{ lines: Line[] }>(`/projects/${encodeURIComponent(id)}/environments/${encodeURIComponent(envId)}/logs?${qs}`)).lines;
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 403)) notFound();
    problem = e instanceof ApiError ? e.message : 'Logs are unavailable right now.';
  }
  return (
    <>
      <p><Link href={`/projects/${id}`}>← Back to project</Link></p>
      <h1>Logs</h1>
      <p className="note">Follow the logs live, or search what was already written.</p>
      <form method="get" className="inline card">
        <div><label htmlFor="q">Contains</label><input id="q" name="q" defaultValue={q} maxLength={100} placeholder="error" /></div>
        <div>
          <label htmlFor="minutes">Period</label>
          <select id="minutes" name="minutes" defaultValue={String(mins)}>
            <option value="15">last 15 minutes</option><option value="60">last hour</option><option value="360">last 6 hours</option><option value="1440">last 24 hours</option>
          </select>
        </div>
        <button data-testid="search-logs">Search</button>
      </form>
      <LiveLogs projectId={id} envId={envId} contains={q.slice(0, 100)} />
      {problem && <p className="error" data-testid="logs-problem">{problem}</p>}
      <div className="card">
        {lines.length === 0 && !problem ? <p className="muted" data-testid="no-logs">No log lines in this period.</p> : (
          // Log text is rendered as TEXT, never as HTML.
          <pre className="mono" data-testid="log-lines" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 }}>
            {lines.map((l) => `${l.ts}  ${l.line}`).join('\n')}
          </pre>
        )}
      </div>
      <p className="note">Container output can contain anything the application prints; take care not to log secrets.</p>
    </>
  );
}
