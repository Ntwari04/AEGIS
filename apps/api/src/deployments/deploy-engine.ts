import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { DockerOps, Router } from './docker-ops';
import { renderRoute, routeFileName } from './nginx-config';

export interface EngineOptions {
  network: string;
  healthTimeoutMs: number;
  healthIntervalMs: number;
  /** false only in tests (no certificates available). */
  tls: boolean;
  /** Container name of Nginx on the network, used to verify a route end to end after switching it. */
  nginxContainer: string;
}

export const DEFAULT_ENGINE_OPTIONS: EngineOptions = {
  network: 'aegisops-net',
  healthTimeoutMs: 60_000,
  healthIntervalMs: 2_000,
  tls: true,
  nginxContainer: 'aegisops-nginx',
};

/**
 * Deployment Engine (PRD 6.4). The invariant that matters, FR-DEPLOY-5:
 *
 *   The route is switched to a new container ONLY AFTER that container has passed its health check,
 *   and the old container is removed ONLY AFTER the route switch succeeded.
 *
 * So a broken container is never routed to (the route file is not touched until it is healthy), and
 * every failure path leaves the previous version both running and routed.
 */
@Injectable()
export class DeployEngine {
  private readonly logger = new Logger(DeployEngine.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly docker: DockerOps,
    private readonly router: Router,
    private readonly opts: EngineOptions = DEFAULT_ENGINE_OPTIONS,
  ) {}

  async run(deploymentId: string): Promise<void> {
    const dep = await this.prisma.deployment.findUniqueOrThrow({
      where: { id: deploymentId },
      include: { environment: { include: { project: true } } },
    });
    if (dep.status !== 'PENDING') return; // already handled (e.g. job redelivered)
    const env = dep.environment;
    const slug = env.project.slug;
    const log: string[] = [];
    const say = async (m: string) => {
      log.push(`${new Date().toISOString()} ${m}`);
      await this.prisma.deployment.update({ where: { id: dep.id }, data: { logs: log.join('\n') } });
    };

    await this.prisma.deployment.update({ where: { id: dep.id }, data: { status: 'RUNNING' } });

    const previous = await this.prisma.deployment.findFirst({
      where: { environmentId: env.id, status: 'SUCCESS', containerName: { not: null }, id: { not: dep.id } },
      orderBy: { finishedAt: 'desc' },
    });
    const name = `aegis-${slug}-${env.name}-${dep.id.slice(0, 8)}`;
    let started = false;

    const fail = async (reason: string) => {
      if (started) {
        const tail = await this.docker.tail(name, 20);
        if (tail) await say(`last container output:\n${tail.trim()}`);
        await this.docker.remove(name).catch(() => undefined);
      }
      const rolledBack = !!previous;
      await say(rolledBack ? `ROLLED BACK: ${reason}. Previous version (${previous!.commitSha?.slice(0, 7) ?? previous!.id.slice(0, 8)}) is still live.` : `FAILED: ${reason}`);
      await this.prisma.deployment.update({
        where: { id: dep.id },
        data: { status: rolledBack ? 'ROLLED_BACK' : 'FAILED', failureReason: reason.slice(0, 500), finishedAt: new Date() },
      });
      await this.audit.record({
        actorId: dep.triggeredById, action: 'deployment.finish', targetType: 'deployment', targetId: dep.id,
        result: 'ERROR', metadata: { status: rolledBack ? 'ROLLED_BACK' : 'FAILED', reason: reason.slice(0, 200) },
      });
    };

    try {
      if (!dep.imageRef) return await fail('deployment has no image reference');

      await say(`pulling ${dep.imageRef}`);
      await this.docker.pull(dep.imageRef);

      await say(`starting ${name}`);
      await this.docker.run({
        name,
        image: dep.imageRef,
        network: this.opts.network,
        env: [`PORT=${env.containerPort}`, `AEGIS_PROJECT=${slug}`, `AEGIS_ENVIRONMENT=${env.name}`, `AEGIS_COMMIT=${dep.commitSha ?? ''}`],
        labels: {
          'aegisops.managed': 'true',
          'aegisops.project': slug,
          'aegisops.environment': env.name,
          'aegisops.deployment': dep.id,
          'aegisops.commit': dep.commitSha ?? '',
        },
        memoryMb: env.memoryLimitMb,
        cpus: env.cpuLimit,
      });
      started = true;

      await say(`health gate: GET ${env.healthPath} on port ${env.containerPort} (timeout ${this.opts.healthTimeoutMs / 1000}s)`);
      const healthy = await this.waitHealthy(name, env.containerPort, env.healthPath);
      if (!healthy) return await fail(`health check failed (${env.healthPath} did not return 2xx in time)`);
      await say('health check passed');

      // Route switch. Skipped (with a note) if the environment has no domain yet.
      if (env.domain) {
        await say(`routing ${env.domain} -> ${name}`);
        try {
          await this.router.apply(
            routeFileName(slug, env.name),
            renderRoute({ projectSlug: slug, environment: env.name, domain: env.domain, containerName: name, port: env.containerPort, tls: this.opts.tls }),
          );
        } catch (e) {
          return await fail(`route switch failed: ${(e as Error).message}`);
        }
        // Verify the route end to end through Nginx itself. If it does not serve, put the old route back.
        const scheme = this.opts.tls ? 'https' : 'http';
        let routed = false;
        for (let i = 0; i < 10 && !routed; i++) {
          routed = await this.docker.probeUrl(`${scheme}://${this.opts.nginxContainer}${env.healthPath}`, this.opts.network, env.domain).catch(() => false);
          if (!routed) await new Promise((r) => setTimeout(r, 500));
        }
        if (!routed) {
          if (previous?.containerName) {
            await this.router.apply(routeFileName(slug, env.name), renderRoute({ projectSlug: slug, environment: env.name, domain: env.domain, containerName: previous.containerName, port: env.containerPort, tls: this.opts.tls })).catch(() => undefined);
          } else {
            await this.router.remove(routeFileName(slug, env.name)).catch(() => undefined);
          }
          return await fail('route verification failed: Nginx did not serve the new container');
        }
        await say('route verified through nginx');
      } else {
        await say('no domain configured for this environment: container is healthy but not routed');
      }

      // Only now is it safe to retire everything else for this environment.
      for (const old of await this.docker.listManaged(slug, env.name)) {
        if (old !== name) await this.docker.remove(old).catch((e) => this.logger.warn(`could not remove ${old}: ${e.message}`));
      }

      await say('SUCCESS');
      await this.prisma.deployment.update({
        where: { id: dep.id },
        data: { status: 'SUCCESS', containerName: name, finishedAt: new Date() },
      });
      await this.audit.record({
        actorId: dep.triggeredById, action: 'deployment.finish', targetType: 'deployment', targetId: dep.id,
        result: 'SUCCESS', metadata: { project: slug, environment: env.name, commit: dep.commitSha },
      });
    } catch (e) {
      await fail(`unexpected error: ${(e as Error).message}`);
    }
  }

  private async waitHealthy(container: string, port: number, path: string) {
    const deadline = Date.now() + this.opts.healthTimeoutMs;
    for (;;) {
      if (await this.docker.probe(container, port, path, this.opts.network).catch(() => false)) return true;
      if (Date.now() + this.opts.healthIntervalMs > deadline) return false;
      await new Promise((r) => setTimeout(r, this.opts.healthIntervalMs));
    }
  }
}
