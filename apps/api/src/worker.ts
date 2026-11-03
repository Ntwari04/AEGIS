import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Global, Module } from '@nestjs/common';
import { Worker } from 'bullmq';
import Docker from 'dockerode';
import { APP_ENV, AppEnv, loadEnv } from './config/env';
import { PrismaModule, PrismaService } from './prisma/prisma.service';
import { AuditModule } from './audit/audit.controller';
import { AuditService } from './audit/audit.service';
import { DeployEngine, DEFAULT_ENGINE_OPTIONS } from './deployments/deploy-engine';
import { DockerodeOps, NginxRouter } from './deployments/docker-ops';
import { DEPLOY_QUEUE } from './deployments/deployments.controller';
import { SecretsService } from './secrets/secrets.service';
import { GitHubApp, GitHubDeployReporter } from './github/github-app';

@Global()
@Module({ providers: [{ provide: APP_ENV, useFactory: (): AppEnv => loadEnv() }], exports: [APP_ENV] })
class WorkerCoreModule {}

@Module({ imports: [WorkerCoreModule, PrismaModule, AuditModule], providers: [SecretsService] })
class WorkerModule {}

/**
 * The deployer process. It is the ONLY component with Docker access (see infra/docker-compose.yml:
 * the API container never mounts the Docker socket). It has no HTTP surface: it only consumes the queue.
 */
async function main() {
  const env = loadEnv();
  const app = await NestFactory.createApplicationContext(WorkerModule);
  const prisma = app.get(PrismaService);
  const audit = app.get(AuditService);

  const docker = new Docker();
  const ghcrUser = process.env.GHCR_USERNAME;
  const ghcrToken = process.env.GHCR_TOKEN;
  const ops = new DockerodeOps(docker, ghcrUser && ghcrToken ? { username: ghcrUser, password: ghcrToken, serveraddress: 'ghcr.io' } : undefined);
  const router = new NginxRouter(docker, process.env.NGINX_CONF_DIR ?? '/nginx-conf.d', process.env.NGINX_CONTAINER ?? 'aegisops-nginx');
  const secrets = app.get(SecretsService);
  if (!secrets.isConfigured()) console.warn('SECRETS_ENCRYPTION_KEY is not set: deployments with stored secrets will fail');
  const ghApp = GitHubApp.fromEnv();
  if (!ghApp) console.warn('GitHub App not configured: deployment status will not be reported to GitHub');
  const engine = new DeployEngine(prisma, audit, ops, router, {
    ...DEFAULT_ENGINE_OPTIONS,
    network: process.env.DOCKER_NETWORK ?? 'aegisops-net',
    healthTimeoutMs: Number(process.env.HEALTH_TIMEOUT_MS ?? 60_000),
    nginxContainer: process.env.NGINX_CONTAINER ?? 'aegisops-nginx',
    webOrigin: env.webOrigin,
  }, secrets, ghApp ? new GitHubDeployReporter(ghApp, (m) => console.warn(m)) : undefined);

  // A deployment left RUNNING by a crashed worker can never finish; fail it so history is honest.
  await prisma.deployment.updateMany({
    where: { status: 'RUNNING' },
    data: { status: 'FAILED', failureReason: 'deployer restarted mid-deployment', finishedAt: new Date() },
  });

  const u = new URL(env.redisUrl);
  // concurrency 1: deployments are serialized, so route-file edits and nginx reloads never interleave.
  const worker = new Worker(DEPLOY_QUEUE, (job) => engine.run(job.data.deploymentId), {
    connection: { host: u.hostname, port: Number(u.port || 6379), password: decodeURIComponent(u.password) },
    concurrency: 1,
  });
  worker.on('failed', (job, err) => console.error(`job ${job?.id} failed: ${err.message}`));
  console.log('deployer ready');

  const stop = async () => { await worker.close(); await app.close(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((e) => { console.error(e); process.exit(1); });
