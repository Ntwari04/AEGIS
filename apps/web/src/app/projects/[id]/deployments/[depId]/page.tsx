import Link from 'next/link';
import { notFound } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import type { DeploymentDto } from '@aegisops/shared-types';

type Detail = DeploymentDto & { logs: string; containerName: string | null; imageRef: string | null };

/** Deployment detail and logs (FR-DEPLOY-3). The log text is plain text, rendered as text (never as HTML). */
export default async function DeploymentPage({
  params, searchParams,
}: { params: Promise<{ id: string; depId: string }>; searchParams: Promise<{ env?: string }> }) {
  const { id, depId } = await params;
  const { env } = await searchParams;
  if (!env) notFound();
  let d: Detail;
  try {
    d = await api<Detail>(
      `/projects/${encodeURIComponent(id)}/environments/${encodeURIComponent(env)}/deployments/${encodeURIComponent(depId)}`,
    );
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 403)) notFound();
    throw e;
  }
  const running = d.status === 'PENDING' || d.status === 'RUNNING';
  return (
    <>
      {running && <meta httpEquiv="refresh" content="3" />}
      <p><Link href={`/projects/${id}`}>← Back to project</Link></p>
      <h1>Deployment <span className="mono">{(d.commitSha ?? '').slice(0, 7) || d.id.slice(0, 8)}</span></h1>
      <div className="card">
        <p>
          <span className="status" data-status={d.status} data-testid="deployment-status">{d.status}</span>{' '}
          <span className="muted">via {d.triggerSource}{d.restoredFromId ? ' (rollback)' : ''}</span>
        </p>
        {d.failureReason && <p className="error mono" data-testid="deployment-failure">{d.failureReason}</p>}
        <table>
          <tbody>
            <tr><th>Image</th><td className="mono">{d.imageRef ?? '—'}</td></tr>
            <tr><th>Container</th><td className="mono">{d.containerName ?? '—'}</td></tr>
            <tr><th>Started</th><td>{new Date(d.startedAt).toLocaleString()}</td></tr>
            <tr><th>Finished</th><td>{d.finishedAt ? new Date(d.finishedAt).toLocaleString() : '—'}</td></tr>
          </tbody>
        </table>
      </div>
      <div className="card">
        <strong>Log</strong>
        <pre className="mono" data-testid="deployment-log" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: '8px 0 0' }}>
          {d.logs || 'No output yet.'}
        </pre>
      </div>
    </>
  );
}
