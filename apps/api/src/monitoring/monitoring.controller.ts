import { Controller, Get, Injectable, Logger, Module } from '@nestjs/common';
import type { AlertDto, MonitoringOverview, PlatformSummary } from '@aegisops/shared-types';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { buildProjects, toAlertDto, type ContainerSamples, type Sample } from './overview';

const ALL_ROLES = ['platform_admin', 'devops_engineer', 'developer', 'auditor'] as const;

/** Reads Prometheus and Alertmanager over the internal network. Queries are FIXED strings: no user input ever reaches PromQL. */
@Injectable()
export class MonitoringClient {
  private readonly logger = new Logger(MonitoringClient.name);
  private readonly prometheus = process.env.PROMETHEUS_URL;
  private readonly alertmanager = process.env.ALERTMANAGER_URL;

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  get configured() {
    return !!this.prometheus;
  }

  private async getJson(url: string): Promise<any> {
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(4000), headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
    return res.json();
  }

  async query(expr: string): Promise<Sample[]> {
    const body = await this.getJson(`${this.prometheus}/api/v1/query?query=${encodeURIComponent(expr)}`);
    if (body.status !== 'success') throw new Error('prometheus query failed');
    return (body.data.result as { metric: Record<string, string>; value: [number, string] }[]).map((r) => ({ metric: r.metric, value: Number(r.value[1]) }));
  }

  async containerSamples(): Promise<ContainerSamples> {
    const [up, restarting, cpu, memory, memoryLimit, restarts1h, started] = await Promise.all([
      this.query('aegisops_container_up{project!=""}'),
      this.query('aegisops_container_restarting{project!=""}'),
      this.query('sum by (project, environment, name)(rate(aegisops_container_cpu_seconds_total{project!=""}[2m]))'),
      this.query('aegisops_container_memory_bytes{project!=""}'),
      this.query('aegisops_container_memory_limit_bytes{project!=""}'),
      this.query('sum by (project, environment, name)(increase(aegisops_container_restart_count{project!=""}[1h]))'),
      this.query('aegisops_container_started_timestamp_seconds{project!=""}'),
    ]);
    return { up, restarting, cpu, memory, memoryLimit, restarts1h, started };
  }

  async platformSummary(): Promise<Omit<PlatformSummary, 'alerts' | 'links'>> {
    const [up, total, mem, disk] = await Promise.all([
      this.query('count(aegisops_container_up{project=""} == 1)'),
      this.query('count(aegisops_container_up{project=""})'),
      this.query('1 - (node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)'),
      this.query('max(1 - (node_filesystem_avail_bytes{mountpoint="/",fstype!~"tmpfs|overlay"} / node_filesystem_size_bytes{mountpoint="/",fstype!~"tmpfs|overlay"}))'),
    ]);
    return {
      containersUp: up[0]?.value ?? 0, containersTotal: total[0]?.value ?? 0,
      hostMemoryUsed: mem[0]?.value ?? null, diskUsed: disk[0]?.value ?? null,
    };
  }

  /** Firing alerts. Empty (not an error) when Alertmanager is not configured. */
  async alerts(): Promise<AlertDto[]> {
    if (!this.alertmanager) return [];
    const body = await this.getJson(`${this.alertmanager}/api/v2/alerts?active=true&silenced=false&inhibited=false`);
    return (body as any[]).map(toAlertDto).sort((a, b) => (a.severity === b.severity ? a.name.localeCompare(b.name) : a.severity === 'critical' ? -1 : 1));
  }
}

@Injectable()
export class MonitoringService {
  private readonly logger = new Logger(MonitoringService.name);
  private readonly grafana = process.env.GRAFANA_PUBLIC_URL;

  constructor(private readonly prisma: PrismaService, private readonly client: MonitoringClient) {}

  async overview(user: AuthUser): Promise<MonitoringOverview> {
    const global = user.roles.includes('platform_admin') || user.roles.includes('auditor');
    // Same visibility rule as the project list (PRD 6.2): members see their projects, admins and auditors see all.
    const projects = await this.prisma.project.findMany({
      where: global ? {} : { members: { some: { userId: user.id } } },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, slug: true, githubRepo: true, environments: { orderBy: { createdAt: 'asc' }, select: { id: true, name: true, isProduction: true } } },
    });
    const envIds = projects.flatMap((p) => p.environments.map((e) => e.id));
    const [latestRows, liveRows] = await Promise.all([
      this.prisma.deployment.findMany({
        where: { environmentId: { in: envIds } }, orderBy: { startedAt: 'desc' }, distinct: ['environmentId'],
        select: { environmentId: true, status: true, commitSha: true, startedAt: true, finishedAt: true },
      }),
      this.prisma.deployment.findMany({
        where: { environmentId: { in: envIds }, status: 'SUCCESS', containerName: { not: null } },
        orderBy: { finishedAt: 'desc' }, distinct: ['environmentId'], select: { environmentId: true, containerName: true },
      }),
    ]);

    // Grafana only admits platform_admin / devops_engineer / auditor, so only they get links (never dead links for developers).
    const grafanaAllowed = user.roles.some((r) => ['platform_admin', 'devops_engineer', 'auditor'].includes(r));
    let samples: ContainerSamples | null = null;
    let alerts: AlertDto[] = [];
    let platform: Omit<PlatformSummary, 'alerts' | 'links'> | undefined;
    let ok = this.client.configured;
    if (ok) {
      try {
        [samples, alerts] = await Promise.all([this.client.containerSamples(), this.client.alerts().catch(() => [])]);
        if (global) platform = await this.client.platformSummary();
      } catch (e) {
        ok = false;
        samples = null;
        this.logger.warn(`monitoring unavailable: ${(e as Error).message}`);
      }
    }

    const visibleSlugs = new Set(projects.map((p) => p.slug));
    const result: MonitoringOverview = {
      monitoring: ok ? 'ok' : 'unavailable',
      generatedAt: new Date().toISOString(),
      projects: buildProjects({
        projects,
        latest: new Map(latestRows.map((d) => [d.environmentId, { status: d.status as any, commitSha: d.commitSha, at: d.finishedAt ?? d.startedAt }])),
        expected: new Map(liveRows.map((d) => [d.environmentId, d.containerName!])),
        samples,
        // a user only ever receives alerts about projects they can see
        alerts: alerts.filter((a) => !a.project || visibleSlugs.has(a.project)),
        nowSeconds: Date.now() / 1000,
        grafana: grafanaAllowed ? this.grafana : undefined,
      }),
    };
    if (global && platform) {
      result.platform = {
        ...platform,
        alerts, // everything, including platform-level alerts with no project
        ...(this.grafana ? { links: { dashboard: `${this.grafana.replace(/\/+$/, '')}/d/aegisops-platform` } } : {}),
      };
    }
    return result;
  }
}

@Controller('monitoring')
export class MonitoringController {
  constructor(private readonly monitoring: MonitoringService) {}

  /** FR-DASH-1/2/4: per-project health for what the caller may see; the platform roll-up only for platform_admin and auditor. */
  @Get('overview')
  @Roles(...ALL_ROLES)
  overview(@CurrentUser() user: AuthUser) {
    return this.monitoring.overview(user);
  }
}

@Module({
  controllers: [MonitoringController],
  providers: [MonitoringService, { provide: MonitoringClient, useFactory: () => new MonitoringClient() }],
  exports: [MonitoringService, MonitoringClient],
})
export class MonitoringModule {}
