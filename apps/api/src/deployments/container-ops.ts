import type { PrismaClient } from '@prisma/client';

export type ContainerAction = 'start' | 'stop' | 'restart';
export const CONTAINER_QUEUE = 'container-ops';

export type ContainerJob =
  | { kind: 'environment'; environmentId: string; action: ContainerAction; requestedById: string }
  | { kind: 'platform'; name: string; action: ContainerAction; requestedById: string; reason: string }
  | { kind: 'drain'; serverId: string; requestedById: string; reason: string };

/**
 * Platform containers an operator may control (FR-INFRA-2). Exact names only: nothing else on the host is ever addressable, whatever
 * the request says. The deployer is excluded: it is the executor itself, and restarting it mid-job would drop the job.
 */
export const PLATFORM_CONTAINERS = [
  'aegisops-postgres', 'aegisops-redis', 'aegisops-keycloak', 'aegisops-api', 'aegisops-web', 'aegisops-nginx',
  'aegisops-data-worker', 'aegisops-prometheus', 'aegisops-alertmanager', 'aegisops-grafana', 'aegisops-loki', 'aegisops-promtail',
  'aegisops-node-exporter', 'aegisops-blackbox', 'aegisops-container-exporter', 'aegisops-docker-proxy',
] as const;

/**
 * Stopping these takes down the path the dashboard itself uses to start them again (queue, database, API, login, proxy), so they
 * can only be RESTARTED from the dashboard. Stopping one needs shell access on the host, deliberately.
 */
export const CRITICAL_PLATFORM_CONTAINERS: ReadonlySet<string> = new Set([
  'aegisops-postgres', 'aegisops-redis', 'aegisops-keycloak', 'aegisops-api', 'aegisops-web', 'aegisops-nginx',
]);

export function platformActionAllowed(name: string, action: ContainerAction): { ok: true } | { ok: false; why: string } {
  if (!(PLATFORM_CONTAINERS as readonly string[]).includes(name)) return { ok: false, why: 'not a controllable platform container' };
  if (action !== 'restart' && CRITICAL_PLATFORM_CONTAINERS.has(name)) return { ok: false, why: 'a critical service can only be restarted from the dashboard (stopping it would cut off the dashboard)' };
  return { ok: true };
}

/** What the executor needs from Docker (dockerode satisfies it through DockerodeOps; tests pass a fake). */
export interface ContainerDocker {
  /** Labels of a container, or null if it does not exist. */
  labelsOf(name: string): Promise<Record<string, string> | null>;
  control(name: string, action: ContainerAction): Promise<void>;
  /** Names of RUNNING containers launched by the Deployment Engine (label aegisops.managed=true). */
  listManagedRunning(): Promise<string[]>;
}

export interface AuditLike {
  record(e: { actorId?: string; actorName?: string; action: string; targetType?: string; targetId?: string; result: 'SUCCESS' | 'DENIED' | 'ERROR'; metadata?: Record<string, unknown> }): Promise<void>;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/** Runs inside the deployer. It re-validates everything the API already checked and resolves the container itself. */
export class ContainerOps {
  constructor(private readonly prisma: PrismaClient, private readonly docker: ContainerDocker, private readonly audit: AuditLike) {}

  async run(job: ContainerJob): Promise<void> {
    switch (job.kind) {
      case 'environment': return this.environment(job);
      case 'platform': return this.platform(job);
      case 'drain': return this.drain(job);
    }
  }

  /** The target is the container of the environment's latest successful deployment, from the DATABASE, never from the request. */
  private async environment(job: Extract<ContainerJob, { kind: 'environment' }>) {
    const env = await this.prisma.environment.findUnique({ where: { id: job.environmentId }, include: { project: true } });
    const dep = env && await this.prisma.deployment.findFirst({ where: { environmentId: env.id, status: 'SUCCESS', containerName: { not: null } }, orderBy: { finishedAt: 'desc' } });
    const meta = { action: job.action, project: env?.project.slug, environment: env?.name };
    const fail = async (why: string) => {
      await this.audit.record({ actorId: job.requestedById, action: `container.${job.action}`, targetType: 'environment', targetId: job.environmentId, result: 'ERROR', metadata: { ...meta, error: why } });
      throw new Error(why);
    };
    if (!env || !dep?.containerName) return fail('nothing is deployed in that environment');
    const labels = await this.docker.labelsOf(dep.containerName);
    if (!labels) return fail('the container does not exist');
    // Defence in depth: it must be one the engine launched, for exactly this project and environment.
    if (labels['aegisops.managed'] !== 'true' || labels['aegisops.project'] !== env.project.slug || labels['aegisops.environment'] !== env.name) return fail('refusing: that container is not managed for this environment');
    try {
      await this.docker.control(dep.containerName, job.action);
    } catch (e) { return fail(errText(e)); }
    await this.audit.record({ actorId: job.requestedById, action: `container.${job.action}`, targetType: 'environment', targetId: env.id, result: 'SUCCESS', metadata: { ...meta, container: dep.containerName } });
  }

  private async platform(job: Extract<ContainerJob, { kind: 'platform' }>) {
    const verdict = platformActionAllowed(job.name, job.action);
    const base = { actorId: job.requestedById, action: `platform.container.${job.action}`, targetType: 'container', targetId: job.name };
    if (!verdict.ok) {
      await this.audit.record({ ...base, result: 'DENIED', metadata: { reason: job.reason, why: verdict.why } });
      throw new Error(verdict.why);
    }
    try {
      await this.docker.control(job.name, job.action);
    } catch (e) {
      await this.audit.record({ ...base, result: 'ERROR', metadata: { reason: job.reason, error: errText(e) } });
      throw e;
    }
    await this.audit.record({ ...base, result: 'SUCCESS', metadata: { reason: job.reason } });
  }

  /** FR-INFRA-3: stop every managed container of a CORDONED server. The cordon is re-checked here, not trusted from the request. */
  private async drain(job: Extract<ContainerJob, { kind: 'drain' }>) {
    const server = await this.prisma.server.findUnique({ where: { id: job.serverId } });
    if (!server?.cordoned) {
      await this.audit.record({ actorId: job.requestedById, action: 'server.drain', targetType: 'server', targetId: job.serverId, result: 'DENIED', metadata: { reason: job.reason, why: 'server is not cordoned' } });
      throw new Error('refusing to drain a server that is not cordoned');
    }
    const stopped: string[] = [];
    const errors: string[] = [];
    for (const name of await this.docker.listManagedRunning()) {
      try { await this.docker.control(name, 'stop'); stopped.push(name); } catch (e) { errors.push(`${name}: ${errText(e)}`); }
    }
    await this.audit.record({ actorId: job.requestedById, action: 'server.drain', targetType: 'server', targetId: server.id, result: errors.length ? 'ERROR' : 'SUCCESS', metadata: { server: server.name, reason: job.reason, stopped, errors } });
    if (errors.length) throw new Error(`drain incomplete: ${errors.join('; ')}`);
  }
}
