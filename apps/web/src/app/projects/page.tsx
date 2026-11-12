import Link from 'next/link';
import { auth } from '@/auth';
import { api } from '@/lib/api';
import { Time } from '@/app/time';
import { AutoRefresh } from '@/app/auto-refresh';
import type { AlertDto, ContainerState, EnvironmentHealth, MonitoringOverview } from '@aegisops/shared-types';

const bytes = (n: number | null) => {
  if (n === null) return '—';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n < 1024 ** 2) return `${Math.max(1, Math.round(n / 1024))} KB`;
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

type Level = 'ok' | 'warning' | 'critical';
/** FR-MON-3 alerts at disk > 85% and memory > 90%: the meter turns critical past that and warns in the last ten points before it. */
const level = (fraction: number, alertAt: number): Level => (fraction > alertAt ? 'critical' : fraction > alertAt - 0.1 ? 'warning' : 'ok');

/** A thin bar beside a number. The number stays the real signal; the bar is for glancing. */
function Meter({ fraction, label, alertAt }: { fraction: number | null; label: string; alertAt?: number }) {
  if (fraction === null) return null;
  const f = Math.min(1, Math.max(0, fraction));
  return (
    <span className="meter" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(f * 100)} data-level={alertAt === undefined ? 'ok' : level(f, alertAt)}>
      <span style={{ width: `${(f * 100).toFixed(1)}%` }} />
    </span>
  );
}

const STATE_LABEL: Record<ContainerState, string> = { up: 'Up', down: 'Down', restarting: 'Restarting', none: 'Not deployed', unknown: 'Unknown' };

type Where = { href: string; label: string; external: boolean };

/**
 * FR-DASH-4: an alert is never a bare notification. Its text leads to the Grafana panel for what is affected and, beside it, to the logs:
 * Grafana's for people who can open it, the dashboard's own log page for those who cannot (developers).
 */
function Alerts({ alerts, panel, logs }: { alerts: AlertDto[]; panel?: Where; logs?: Where }) {
  if (alerts.length === 0) return <span className="muted">none</span>;
  const open = (w: Where, text: React.ReactNode, testid: string) =>
    w.external
      ? <a href={w.href} target="_blank" rel="noopener noreferrer" data-testid={testid}>{text}</a>
      : <Link href={w.href} data-testid={testid}>{text}</Link>;
  return (
    <ul className="alerts" data-testid="env-alerts">
      {alerts.map((a, i) => (
        <li key={`${a.name}-${i}`}>
          <span className="sev" data-sev={a.severity}>{a.severity}</span>{' '}
          {panel ? open(panel, a.summary, 'alert-panel') : a.summary}
          {logs && <> · {open(logs, logs.label, 'alert-logs')}</>}
        </li>
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
      <td className="mono" data-label="CPU">
        {e.cpuCores === null ? '—' : `${(e.cpuCores * 100).toFixed(1)}%`}
        {/* No CPU limit reaches the dashboard, so the bar is a share of one core and has no alert colour. */}
        <Meter fraction={e.cpuCores} label="CPU, share of one core" />
      </td>
      <td className="mono" data-label="Memory">
        {bytes(e.memoryBytes)}
        {e.memoryLimitBytes ? <span className="muted"> / {bytes(e.memoryLimitBytes)}{memPct !== null && ` (${pct(memPct)})`}</span> : null}
        <Meter fraction={memPct} label="Memory used of its limit" alertAt={0.9} />
      </td>
      <td className="mono" data-label="Storage" data-testid={`storage-${e.name}`}>{bytes(e.diskBytes)}</td>
      <td data-label="Alerts">
        <Alerts
          alerts={e.alerts}
          panel={e.links ? { href: e.links.dashboard, label: 'metrics', external: true } : undefined}
          logs={e.links ? { href: e.links.logs, label: 'logs', external: true } : { href: `/projects/${projectId}/environments/${e.id}/logs`, label: 'logs', external: false }}
        />
      </td>
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
      <AutoRefresh everyMs={inFlight ? 4_000 : 15_000} />
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
            <div>
              <div className="big">{pct(data.platform.hostMemoryUsed)}</div><div className="muted">host memory used</div>
              <Meter fraction={data.platform.hostMemoryUsed} label="Host memory used" alertAt={0.9} />
            </div>
            <div>
              <div className="big">{pct(data.platform.diskUsed)}</div><div className="muted">disk used</div>
              <Meter fraction={data.platform.diskUsed} label="Disk used" alertAt={0.85} />
            </div>
            <div><div className="big" data-testid="platform-alert-count" data-bad={data.platform.alerts.length > 0}>{data.platform.alerts.length}</div><div className="muted">alerts firing</div></div>
          </div>
          {data.platform.alerts.length > 0 && (
            <Alerts alerts={data.platform.alerts} panel={data.platform.links ? { href: data.platform.links.dashboard, label: 'metrics', external: true } : undefined} />
          )}
        </div>
      )}

      {data.projects.length === 0 ? (
        <div className="card empty-box"><p className="muted" data-testid="empty">You have no projects yet.</p></div>
      ) : (
        data.projects.map((p) => (
          <div className="card" key={p.id} data-testid={`project-${p.slug}`}>
            <div className="row">
              <div>
                <Link href={`/projects/${p.id}`}><strong className="project-name">{p.name}</strong></Link>{' '}
                <span className="muted mono">{p.githubRepo ?? 'no repository'}</span>
              </div>
              {p.openAlerts > 0 && <span className="sev" data-sev="critical" data-testid={`alerts-${p.slug}`}>{p.openAlerts} open alert{p.openAlerts === 1 ? '' : 's'}</span>}
            </div>
            {p.environments.length === 0 ? (
              <div className="empty-box"><p className="muted">No environments yet.</p></div>
            ) : (
              <table className="stack">
                <thead><tr><th>Environment</th><th>Deployment</th><th>Health</th><th>CPU</th><th>Memory</th><th>Storage</th><th>Alerts</th><th><span className="sr-only">Links</span></th></tr></thead>
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
