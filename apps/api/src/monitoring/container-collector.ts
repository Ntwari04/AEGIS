import { Gauge, Registry } from 'prom-client';

/** The slice of the Docker API the collector needs (dockerode satisfies it; tests pass a fake). */
export interface DockerLike {
  listContainers(opts: { all: boolean; filters?: Record<string, string[]> }): Promise<{ Id: string; Names: string[]; State: string; Labels?: Record<string, string> }[]>;
  getContainer(id: string): {
    inspect(): Promise<{
      RestartCount?: number;
      HostConfig?: { Memory?: number };
      State?: { Running?: boolean; Restarting?: boolean; StartedAt?: string; Health?: { Status?: string } };
    }>;
    stats(opts: { stream: false }): Promise<{
      cpu_stats?: { cpu_usage?: { total_usage?: number } };
      memory_stats?: { usage?: number; stats?: Record<string, number>; limit?: number };
      networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>;
    }>;
  };
}

const LABELS = ['name', 'project', 'environment'] as const;
const HEALTH_STATES = ['healthy', 'unhealthy', 'starting', 'none'] as const;

/**
 * Container metrics straight from the Docker API (FR-MON-2, FR-DASH-1), read through the read-only docker-proxy.
 * `project` / `environment` come ONLY from the aegisops.* labels the Deployment Engine sets, so every managed container
 * is discovered with no per-project configuration. Platform containers have no such labels and simply carry `name`.
 */
export class ContainerCollector {
  readonly registry: Registry;
  private readonly up: Gauge<string>;
  private readonly restarting: Gauge<string>;
  private readonly restartCount: Gauge<string>;
  private readonly started: Gauge<string>;
  private readonly health: Gauge<string>;
  private readonly cpu: Gauge<string>;
  private readonly mem: Gauge<string>;
  private readonly memLimit: Gauge<string>;
  private readonly rx: Gauge<string>;
  private readonly tx: Gauge<string>;
  private readonly lastRefresh: Gauge<string>;
  private readonly refreshErrors: Gauge<string>;

  /** @param network only containers attached to this Docker network are reported (the platform's own network), so other workloads on the host are never read. */
  constructor(private readonly docker: DockerLike, private readonly now: () => number = Date.now, registry = new Registry(), private readonly network = 'aegisops-net') {
    this.registry = registry;
    const g = (name: string, help: string, labels: readonly string[] = LABELS) =>
      new Gauge({ name, help, labelNames: [...labels], registers: [registry] });
    this.up = g('aegisops_container_up', '1 if the container is running');
    this.restarting = g('aegisops_container_restarting', '1 if the container is in a restart loop');
    this.restartCount = g('aegisops_container_restart_count', 'Restarts performed by Docker since the container was created');
    this.started = g('aegisops_container_started_timestamp_seconds', 'Unix time the container last started');
    this.health = g('aegisops_container_health', '1 for the container\'s Docker health state (healthy / unhealthy / starting / none)', [...LABELS, 'status']);
    this.cpu = g('aegisops_container_cpu_seconds_total', 'CPU time consumed (use rate() for cores in use)');
    this.mem = g('aegisops_container_memory_bytes', 'Memory in use (excluding reclaimable page cache)');
    this.memLimit = g('aegisops_container_memory_limit_bytes', 'Configured memory limit; the series is absent when no limit is set');
    this.rx = g('aegisops_container_network_receive_bytes_total', 'Bytes received');
    this.tx = g('aegisops_container_network_transmit_bytes_total', 'Bytes transmitted');
    this.lastRefresh = g('aegisops_container_exporter_last_refresh_timestamp_seconds', 'When the container list was last read successfully', []);
    this.refreshErrors = g('aegisops_container_exporter_errors', 'Containers that could not be read in the last refresh', []);
  }

  /** Reads every container once and replaces the exported series. A container that disappears drops out immediately. */
  async refresh(): Promise<void> {
    const list = await this.docker.listContainers({ all: true, filters: { network: [this.network] } });
    let errors = 0;
    const rows = await Promise.all(
      list.map(async (c) => {
        const name = (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, '');
        const labels = {
          name,
          project: c.Labels?.['aegisops.project'] ?? '',
          environment: c.Labels?.['aegisops.environment'] ?? '',
        };
        try {
          const ref = this.docker.getContainer(c.Id);
          const info = await withTimeout(ref.inspect(), 5000);
          const running = c.State === 'running' || info.State?.Running === true;
          const stats = running ? await withTimeout(ref.stats({ stream: false }), 8000) : undefined;
          return { labels, c, info, running, stats };
        } catch {
          errors++;
          return undefined;
        }
      }),
    );

    for (const g of [this.up, this.restarting, this.restartCount, this.started, this.health, this.cpu, this.mem, this.memLimit, this.rx, this.tx]) g.reset();
    for (const r of rows) {
      if (!r) continue;
      const { labels, info, running, stats } = r;
      this.up.set(labels, running ? 1 : 0);
      this.restarting.set(labels, info.State?.Restarting || r.c.State === 'restarting' ? 1 : 0);
      this.restartCount.set(labels, info.RestartCount ?? 0);
      const startedAt = info.State?.StartedAt ? Date.parse(info.State.StartedAt) : NaN;
      if (Number.isFinite(startedAt) && startedAt > 0) this.started.set(labels, startedAt / 1000);
      const status = info.State?.Health?.Status ?? 'none';
      for (const s of HEALTH_STATES) this.health.set({ ...labels, status: s }, status === s ? 1 : 0);

      if (stats) {
        if (stats.cpu_stats?.cpu_usage?.total_usage !== undefined) this.cpu.set(labels, stats.cpu_stats.cpu_usage.total_usage / 1e9);
        const m = stats.memory_stats;
        if (m?.usage !== undefined) {
          // Same definition `docker stats` uses: usage minus reclaimable cache (cgroup v2 inactive_file, v1 cache).
          const cache = m.stats?.inactive_file ?? m.stats?.total_inactive_file ?? m.stats?.cache ?? 0;
          this.mem.set(labels, Math.max(0, m.usage - cache));
        }
        const limit = info.HostConfig?.Memory ?? 0; // our own setting; stats.limit is the whole host when unset
        if (limit > 0) this.memLimit.set(labels, limit);
        let rx = 0;
        let tx = 0;
        for (const n of Object.values(stats.networks ?? {})) { rx += n.rx_bytes ?? 0; tx += n.tx_bytes ?? 0; }
        this.rx.set(labels, rx);
        this.tx.set(labels, tx);
      }
    }
    this.refreshErrors.set(errors);
    this.lastRefresh.set(this.now() / 1000);
  }

  metrics() {
    return this.registry.metrics();
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error('timeout')), ms); }),
  ]);
}
