import Link from 'next/link';
import { auth } from '@/auth';
import { api } from '@/lib/api';
import { Time } from '@/app/time';
import type { AlertDto, ContainerState, EnvironmentHealth, MonitoringOverview } from '@aegisops/shared-types';

const bytes = (n: number | null) => {
  if (n === null) return '—';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(n / 1024 ** 2)} MB`;
};
const pct = (n: number | null) => (n === null ? '—' : `${Math.round(n * 100)}%`);
const uptime = (s: number | null) => {
  if (s === null) return '';
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
};

const STATE_LABEL: Record<ContainerState, string> = { up: 'Up', down: 'Down', restarting: 'Restarting', none: 'Not deployed', unknown: 'Unknown' };

function Alerts({ alerts }: { alerts: AlertDto[] }) {
  if (alerts.length === 0) return <span className="muted">none</span>;
  return (
    <ul className="alerts" data-testid="env-alerts">
      {alerts.map((a, i) => (
        <li key={`${a.name}-${i}`}><span className="sev" data-sev={a.severity}>{a.severity}</span> {a.summary}</li>
      ))}
    </ul>
  );
}

function EnvRow({ projectId, e }: { projectId: string; e: EnvironmentHealth }) {
  const memPct = e.memoryBytes !== null && e.memoryLimitBytes ? e.memoryBytes / e.memoryLimitBytes : null;
  return (
    <tr data-testid={`health-${e.name}`}>
      <td data-label="Environment">
        <Link href={`/projects/${projectId}`}>{e.name}</Link> {e.isProduction && <span className="role">production</span>}
      </td>
      <td data-label="Deployment">
        {e.deployment ? (
          <>
            <span className="status" data-status={e.deployment.status}>{e.deployment.status}</span>
            <div className="muted mono">{(e.deployment.commitSha ?? '').slice(0, 7)}</div>
          </>
        ) : <span className="muted">—</span>}
      </td>
      <td data-label="Health">
        <span className="state" data-state={e.state} data-testid={`state-${e.name}`}>{STATE_LABEL[e.state]}</span>
        {e.uptimeSeconds !== null && <div className="muted">up {uptime(e.uptimeSeconds)}</div>}
        {e.restarts1h ? <div className="error">{e.restarts1h} restart(s) in 1h</div> : null}
      </td>
      <td className="mono" data-label="CPU">{e.cpuCores === null ? '—' : `${(e.cpuCores * 100).toFixed(1)}%`}</td>
      <td className="mono" data-label="Memory">
        {bytes(e.memoryBytes)}
        {e.memoryLimitBytes ? <span className="muted"> / {bytes(e.memoryLimitBytes)}{memPct !== null && ` (${pct(memPct)})`}</span> : null}
      </td>
      <td data-label="Alerts"><Alerts alerts={e.alerts} /></td>
      <td>
        {e.links ? (
          <span className="links">
            <a href={e.links.dashboard} target="_blank" rel="noopener noreferrer">Metrics</a>{' · '}
            <a href={e.links.logs} target="_blank" rel="noopener noreferrer">Logs</a>
          </span>
        ) : <span className="muted">—</span>}
      </td>
    </tr>
  );
}

export default async function ProjectsPage() {
  const session = await auth();
  const roles: string[] = (session as any)?.roles ?? [];
  const canCreate = roles.includes('platform_admin') || roles.includes('devops_engineer');
  const data = await api<MonitoringOverview>('/monitoring/overview');
  const inFlight = data.projects.some((p) => p.environments.some((e) => e.deployment && (e.deployment.status === 'PENDING' || e.deployment.status === 'RUNNING')));

  return (
    <>
      {/* Health changes without a click: refresh every 15s (4s while a deployment is running). */}
      <meta httpEquiv="refresh" content={inFlight ? '4' : '15'} />
      <div className="row">
        <h1>Projects</h1>
        {canCreate && <Link className="btn" href="/projects/new" data-testid="new-project">New project</Link>}
      </div>

      {data.monitoring === 'unavailable' && (
        <p className="error" data-testid="monitoring-unavailable">
          Live health data is unavailable right now, so container state shows as unknown. Deployments are unaffected.
        </p>
      )}

      {data.platform && (
        <div className="card" data-testid="platform-summary">
          <div className="row">
            <strong>Platform</strong>
            {data.platform.links && <a href={data.platform.links.dashboard} target="_blank" rel="noopener noreferrer">Open in Grafana</a>}
          </div>
          <div className="stats">
            <div><div className="big" data-testid="platform-containers">{data.platform.containersUp}/{data.platform.containersTotal}</div><div className="muted">platform containers up</div></div>
            <div><div className="big">{pct(data.platform.hostMemoryUsed)}</div><div className="muted">host memory used</div></div>
            <div><div className="big">{pct(data.platform.diskUsed)}</div><div className="muted">disk used</div></div>
            <div><div className="big" data-testid="platform-alert-count" data-bad={data.platform.alerts.length > 0}>{data.platform.alerts.length}</div><div className="muted">alerts firing</div></div>
          </div>
          {data.platform.alerts.length > 0 && <Alerts alerts={data.platform.alerts} />}
        </div>
      )}

      {data.projects.length === 0 ? (
        <div className="card"><p className="muted" data-testid="empty">You have no projects yet.</p></div>
      ) : (
        data.projects.map((p) => (
          <div className="card" key={p.id} data-testid={`project-${p.slug}`}>
            <div className="row">
              <div>
                <Link href={`/projects/${p.id}`}><strong>{p.name}</strong></Link>{' '}
                <span className="muted mono">{p.githubRepo ?? 'no repository'}</span>
              </div>
              {p.openAlerts > 0 && <span className="sev" data-sev="critical" data-testid={`alerts-${p.slug}`}>{p.openAlerts} open alert{p.openAlerts === 1 ? '' : 's'}</span>}
            </div>
            {p.environments.length === 0 ? (
              <p className="muted">No environments yet.</p>
            ) : (
              <table className="stack">
                <thead><tr><th>Environment</th><th>Deployment</th><th>Health</th><th>CPU</th><th>Memory</th><th>Alerts</th><th /></tr></thead>
                <tbody>{p.environments.map((e) => <EnvRow key={e.id} projectId={p.id} e={e} />)}</tbody>
              </table>
            )}
          </div>
        ))
      )}
      <p className="muted">Updated <Time iso={data.generatedAt} timeOnly /></p>
    </>
  );
}
