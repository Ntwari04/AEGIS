import type { AlertDto, ContainerState, DeploymentStatus, EnvironmentHealth, ProjectOverview } from '@aegisops/shared-types';

/** One Prometheus sample, already reduced to its labels and value. */
export interface Sample {
  metric: Record<string, string>;
  value: number;
}

export interface ContainerSamples {
  up: Sample[];
  restarting: Sample[];
  cpu: Sample[];
  memory: Sample[];
  memoryLimit: Sample[];
  restarts1h: Sample[];
  started: Sample[];
}

export interface OverviewInput {
  projects: {
    id: string; name: string; slug: string; githubRepo: string | null;
    environments: { id: string; name: string; isProduction: boolean }[];
  }[];
  /** environment id -> latest deployment (any status) */
  latest: Map<string, { status: DeploymentStatus; commitSha: string | null; at: Date }>;
  /** environment id -> container name of its latest SUCCESSFUL deployment (the one that should be running) */
  expected: Map<string, string>;
  /** null when Prometheus could not be reached */
  samples: ContainerSamples | null;
  alerts: AlertDto[];
  nowSeconds: number;
  /** Grafana base URL when the caller may use Grafana, else undefined (links are then omitted). */
  grafana?: string;
}

const byName = (samples: Sample[], name: string) => samples.find((s) => s.metric.name === name)?.value ?? null;

/**
 * Per-environment health (FR-DASH-1). The container that SHOULD be running comes from the database (latest successful
 * deployment), not from what Prometheus happens to report, so a container that has disappeared entirely is "down",
 * not silently missing.
 */
export function buildProjects(input: OverviewInput): ProjectOverview[] {
  const { samples, grafana } = input;
  return input.projects.map((p) => {
    const environments: EnvironmentHealth[] = p.environments.map((e) => {
      const container = input.expected.get(e.id) ?? null;
      const dep = input.latest.get(e.id);
      let state: ContainerState;
      if (!container) state = 'none';
      else if (!samples) state = 'unknown';
      else {
        const up = byName(samples.up, container);
        const restarting = byName(samples.restarting, container) === 1;
        state = up === 1 ? (restarting ? 'restarting' : 'up') : restarting ? 'restarting' : 'down';
      }
      const alerts = input.alerts.filter((a) => a.project === p.slug && a.environment === e.name);
      const started = container && samples ? byName(samples.started, container) : null;
      const running = state === 'up' || state === 'restarting';
      return {
        id: e.id, name: e.name, isProduction: e.isProduction,
        deployment: dep ? { status: dep.status, commitSha: dep.commitSha, at: dep.at.toISOString() } : null,
        state, container,
        cpuCores: running && samples && container ? byName(samples.cpu, container) : null,
        memoryBytes: running && samples && container ? byName(samples.memory, container) : null,
        memoryLimitBytes: running && samples && container ? byName(samples.memoryLimit, container) : null,
        restarts1h: samples && container ? byName(samples.restarts1h, container) : null,
        uptimeSeconds: running && started ? Math.max(0, Math.round(input.nowSeconds - started)) : null,
        alerts,
        ...(grafana ? { links: environmentLinks(grafana, p.slug, e.name) } : {}),
      };
    });
    return {
      id: p.id, name: p.name, slug: p.slug, githubRepo: p.githubRepo, environments,
      openAlerts: environments.reduce((n, e) => n + e.alerts.length, 0),
    };
  });
}

/** FR-DASH-4: alerts and environments link to the Grafana dashboard / a Loki log query for exactly that environment. */
export function environmentLinks(grafana: string, project: string, environment: string) {
  const base = grafana.replace(/\/+$/, '');
  const q = new URLSearchParams({ 'var-project': project, 'var-environment': environment });
  const logQuery = `{project="${escapeLogQl(project)}", environment="${escapeLogQl(environment)}"}`;
  const pane = { a: { datasource: 'loki', queries: [{ refId: 'A', expr: logQuery, datasource: { type: 'loki', uid: 'loki' } }], range: { from: 'now-1h', to: 'now' } } };
  const explore = new URLSearchParams({ schemaVersion: '1', panes: JSON.stringify(pane), orgId: '1' });
  return {
    dashboard: `${base}/d/aegisops-env?${q.toString()}`,
    logs: `${base}/explore?${explore.toString()}`,
  };
}

function escapeLogQl(v: string) {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Alertmanager v2 alert -> AlertDto. Only the fields the dashboard shows; no generator URLs or fingerprints. */
export function toAlertDto(a: { labels?: Record<string, string>; annotations?: Record<string, string>; startsAt?: string }): AlertDto {
  const l = a.labels ?? {};
  return {
    name: l.alertname ?? 'unknown',
    severity: l.severity ?? 'warning',
    summary: a.annotations?.summary ?? l.alertname ?? '',
    since: a.startsAt ?? new Date(0).toISOString(),
    ...(l.project ? { project: l.project } : {}),
    ...(l.environment ? { environment: l.environment } : {}),
  };
}
