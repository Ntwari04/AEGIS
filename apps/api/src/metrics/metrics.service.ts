import { Inject, Injectable, Optional } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { PrismaService } from '../prisma/prisma.service';
import { DEPLOYMENT_QUEUE, type DeploymentQueue } from '../deployments/deployments.controller';

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

  render() {
    return this.registry.metrics();
  }
}
