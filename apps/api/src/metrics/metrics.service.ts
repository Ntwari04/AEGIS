import { Inject, Injectable, Optional } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { PrismaService } from '../prisma/prisma.service';
import { DEPLOYMENT_QUEUE, type DeploymentQueue } from '../deployments/deployments.controller';

interface BackupSnapshot {
  lastFinished: Map<string, { status: string }>;
  lastSuccess: Map<string, { startedAt: Date; sizeBytes: bigint | null }>;
  lastDrill: Map<string, { status: string }>;
  lastDrillSuccess: Map<string, { finishedAt: Date | null; durationMs: number | null }>;
}

/**
 * Prometheus metrics for the platform (FR-MON-1). Label values never come from user input: routes are the matched
 * route PATTERN (not the URL, so ids do not blow up cardinality) and project / environment names come from the database.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();
  private readonly requests: Counter<'method' | 'route' | 'status_class'>;
  private readonly latency: Histogram<'method' | 'route'>;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(DEPLOYMENT_QUEUE) private readonly queue?: DeploymentQueue,
  ) {
    collectDefaultMetrics({ register: this.registry, prefix: 'aegisops_' });

    this.requests = new Counter({
      name: 'aegisops_http_requests_total', help: 'HTTP requests handled by the API',
      labelNames: ['method', 'route', 'status_class'], registers: [this.registry],
    });
    this.latency = new Histogram({
      name: 'aegisops_http_request_duration_seconds', help: 'HTTP request latency',
      labelNames: ['method', 'route'], buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5], registers: [this.registry],
    });

    const self = this;
    new Gauge({
      name: 'aegisops_deployments_total', labelNames: ['project', 'environment', 'status'], registers: [this.registry],
      help: 'Deployments by outcome, counted from the database at scrape time (only ever grows, so increase() works)',
      async collect() {
        this.reset();
        for (const r of await self.deploymentCounts()) this.set({ project: r.project, environment: r.environment, status: r.status }, r.count);
      },
    });
    new Gauge({
      name: 'aegisops_environment_expected_up', labelNames: ['project', 'environment', 'name'], registers: [this.registry],
      help: '1 for every environment whose latest successful deployment owns a container that should be running',
      async collect() {
        this.reset();
        for (const r of await self.expectedContainers()) this.set({ project: r.project, environment: r.environment, name: r.name }, 1);
      },
    });
    // Backups and restore drills (FR-BACKUP-5): the alert rules read these. Only targets that exist today are reported, so a deleted
    // database does not alert forever.
    const gauge = (name: string, help: string, labelNames: string[], fill: (g: Gauge<string>, d: BackupSnapshot) => void) =>
      new Gauge({
        name, help, labelNames, registers: [this.registry],
        async collect() { this.reset(); fill(this, await self.backupSnapshot()); },
      });
    gauge('aegisops_backup_last_status', '1 if the most recent finished backup of the target succeeded, 0 if it failed', ['target'], (g, d) => {
      for (const [t, r] of d.lastFinished) g.set({ target: t }, r.status === 'SUCCESS' ? 1 : 0);
    });
    gauge('aegisops_backup_last_success_timestamp_seconds', 'Unix time the last successful backup of the target started', ['target'], (g, d) => {
      for (const [t, r] of d.lastSuccess) g.set({ target: t }, r.startedAt.getTime() / 1000);
    });
    gauge('aegisops_backup_last_size_bytes', 'Stored (encrypted) size of the last successful backup', ['target'], (g, d) => {
      for (const [t, r] of d.lastSuccess) if (r.sizeBytes !== null) g.set({ target: t }, Number(r.sizeBytes));
    });
    gauge('aegisops_restore_drill_last_status', '1 if the most recent restore drill of the target succeeded (restored AND verified), 0 if not', ['target'], (g, d) => {
      for (const [t, r] of d.lastDrill) g.set({ target: t }, r.status === 'SUCCESS' ? 1 : 0);
    });
    gauge('aegisops_restore_drill_last_success_timestamp_seconds', 'Unix time the last successful restore drill of the target finished', ['target'], (g, d) => {
      for (const [t, r] of d.lastDrillSuccess) if (r.finishedAt) g.set({ target: t }, r.finishedAt.getTime() / 1000);
    });
    gauge('aegisops_restore_drill_duration_seconds', 'How long the last successful restore drill took: the measured restore time', ['target'], (g, d) => {
      for (const [t, r] of d.lastDrillSuccess) if (r.durationMs !== null) g.set({ target: t }, r.durationMs / 1000);
    });
    new Gauge({
      name: 'aegisops_restore_rto_seconds', help: 'The restore time objective a drill is held to (PRD 7)', registers: [this.registry],
      collect() { this.set(Number(process.env.BACKUP_RTO_SECONDS ?? 4 * 3600)); },
    });
    new Gauge({
      name: 'aegisops_deploy_queue_jobs', labelNames: ['state'], registers: [this.registry],
      help: 'Deployment queue depth by BullMQ job state',
      async collect() {
        this.reset();
        const counts = (await self.queue?.counts?.().catch(() => undefined)) ?? {};
        for (const [state, n] of Object.entries(counts)) this.set({ state }, n);
      },
    });
  }

  /** Called once per finished request by the middleware. */
  observe(method: string, route: string, status: number, seconds: number) {
    this.requests.inc({ method, route, status_class: `${Math.floor(status / 100)}xx` });
    this.latency.observe({ method, route }, seconds);
  }

  async deploymentCounts() {
    const [rows, envs] = await Promise.all([
      this.prisma.deployment.groupBy({ by: ['environmentId', 'status'], _count: { _all: true } }),
      this.prisma.environment.findMany({ select: { id: true, name: true, project: { select: { slug: true } } } }),
    ]);
    const byId = new Map(envs.map((e) => [e.id, e]));
    return rows.flatMap((r) => {
      const e = byId.get(r.environmentId);
      return e ? [{ project: e.project.slug, environment: e.name, status: r.status as string, count: r._count._all }] : [];
    });
  }

  /** One live container per environment: the newest SUCCESS deployment (older ones are removed when a newer one succeeds). */
  async expectedContainers() {
    const rows = await this.prisma.deployment.findMany({
      where: { status: 'SUCCESS', containerName: { not: null } },
      orderBy: { finishedAt: 'desc' },
      distinct: ['environmentId'],
      select: { containerName: true, environment: { select: { name: true, project: { select: { slug: true } } } } },
    });
    return rows.map((r) => ({ project: r.environment.project.slug, environment: r.environment.name, name: r.containerName! }));
  }

  /** One query set per scrape: latest finished backup, latest success and latest drill, for every target that still exists. */
  async backupSnapshot(): Promise<BackupSnapshot> {
    const dbs = await this.prisma.database.findMany({ select: { id: true } });
    const live = new Set(['system:aegisops', 'system:keycloak', ...dbs.map((d) => `db:${d.id}`)]);
    const [jobs, drills] = await Promise.all([
      this.prisma.backupJob.findMany({
        where: { target: { in: [...live] }, status: { in: ['SUCCESS', 'FAILED'] } }, orderBy: { startedAt: 'desc' }, take: 500,
        select: { target: true, status: true, startedAt: true, sizeBytes: true },
      }),
      this.prisma.restoreJob.findMany({
        where: { kind: 'DRILL', status: { in: ['SUCCESS', 'FAILED'] }, backup: { target: { in: [...live] } } }, orderBy: { startedAt: 'desc' }, take: 500,
        select: { status: true, finishedAt: true, durationMs: true, backup: { select: { target: true } } },
      }),
    ]);
    const snap: BackupSnapshot = { lastFinished: new Map(), lastSuccess: new Map(), lastDrill: new Map(), lastDrillSuccess: new Map() };
    for (const j of jobs) { // newest first: the first row seen per target wins
      if (!snap.lastFinished.has(j.target)) snap.lastFinished.set(j.target, j);
      if (j.status === 'SUCCESS' && !snap.lastSuccess.has(j.target)) snap.lastSuccess.set(j.target, j);
    }
    for (const r of drills) {
      const t = r.backup.target;
      if (!snap.lastDrill.has(t)) snap.lastDrill.set(t, r);
      if (r.status === 'SUCCESS' && !snap.lastDrillSuccess.has(t)) snap.lastDrillSuccess.set(t, r);
    }
    return snap;
  }

  render() {
    return this.registry.metrics();
  }
}
