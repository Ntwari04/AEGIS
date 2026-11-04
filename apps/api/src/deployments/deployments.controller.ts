import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Headers, HttpCode, Inject, Injectable, Module,
  NotFoundException, OnModuleDestroy, Param, Post, Req, UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Queue } from 'bullmq';
import { IsOptional, IsString, Length, Matches } from 'class-validator';
import { CurrentUser, ProjectAccess, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/auth.types';
import { Audited } from '../audit/audit.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import { APP_ENV, AppEnv } from '../config/env';
import { Public } from '../auth/decorators';
import { AuditService } from '../audit/audit.service';
import { verifyGithubSignature, imageRepoFor } from './github';
import { ProjectsModule } from '../projects/projects.controller';

export const DEPLOY_QUEUE = 'deployments';

export interface DeploymentQueue {
  enqueue(deploymentId: string): Promise<void>;
  /** Jobs per state, for the queue-depth metric (FR-MON-1). Optional so tests can stub the queue. */
  counts?(): Promise<Record<string, number>>;
}
export const DEPLOYMENT_QUEUE = Symbol('DEPLOYMENT_QUEUE');

@Injectable()
export class BullDeploymentQueue implements DeploymentQueue, OnModuleDestroy {
  private readonly queue: Queue;
  constructor(@Inject(APP_ENV) env: AppEnv) {
    const u = new URL(env.redisUrl);
    this.queue = new Queue(DEPLOY_QUEUE, {
      connection: { host: u.hostname, port: Number(u.port || 6379), password: decodeURIComponent(u.password), lazyConnect: true },
    });
  }
  async enqueue(deploymentId: string) {
    // jobId = deploymentId makes enqueueing idempotent.
    await this.queue.add('deploy', { deploymentId }, { jobId: deploymentId, removeOnComplete: 500, removeOnFail: 500, attempts: 1 });
  }
  counts() {
    return this.queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
  }
  onModuleDestroy() {
    return this.queue.close();
  }
}

class TriggerDto {
  @IsString() @Length(40, 40) @Matches(/^[0-9a-f]{40}$/, { message: 'commitSha must be a full 40-char sha' }) commitSha!: string;
  @IsOptional() @IsString() @Length(1, 200) @Matches(/^[A-Za-z0-9_.\/:@-]+$/) imageRef?: string;
}

const COMMIT = /^[0-9a-f]{40}$/;

@Injectable()
export class DeploymentsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(DEPLOYMENT_QUEUE) private readonly queue: DeploymentQueue,
  ) {}

  /**
   * FR-INFRA-3: a CORDONED server accepts no new deployments. v1 runs on one host, so an environment with no explicit server belongs
   * to the first registered one. Whatever is already running there keeps running.
   */
  async assertSchedulable(environmentId: string) {
    const env = await this.prisma.environment.findUnique({ where: { id: environmentId }, select: { serverId: true } });
    const server = env?.serverId
      ? await this.prisma.server.findUnique({ where: { id: env.serverId } })
      : await this.prisma.server.findFirst({ orderBy: { createdAt: 'asc' } });
    if (server?.cordoned) throw new ConflictException(`Server ${server.name} is cordoned and accepts no new deployments`);
  }

  /** Creates the PENDING record and enqueues it. Idempotent on `idempotencyKey` so a retried webhook cannot double-deploy. */
  async create(args: {
    environmentId: string; commitSha: string; imageRef: string; source: 'webhook' | 'manual' | 'rollback' | 'api-key';
    triggeredById?: string | null; idempotencyKey?: string; restoredFromId?: string;
  }) {
    if (args.idempotencyKey) {
      const existing = await this.prisma.deployment.findUnique({ where: { idempotencyKey: args.idempotencyKey } });
      if (existing) return { deployment: existing, created: false };
    }
    await this.assertSchedulable(args.environmentId);
    const deployment = await this.prisma.deployment.create({
      data: {
        environmentId: args.environmentId, commitSha: args.commitSha, imageRef: args.imageRef, triggerSource: args.source,
        triggeredById: args.triggeredById ?? null, idempotencyKey: args.idempotencyKey, restoredFromId: args.restoredFromId,
        logs: `${new Date().toISOString()} queued (${args.source})`,
      },
    });
    await this.queue.enqueue(deployment.id);
    return { deployment, created: true };
  }
}

@Controller('projects/:projectId/environments/:envId')
export class DeploymentsController {
  constructor(private readonly prisma: PrismaService, private readonly svc: DeploymentsService) {}

  private async env(projectId: string, envId: string) {
    const env = await this.prisma.environment.findFirst({ where: { id: envId, projectId }, include: { project: true } });
    if (!env) throw new NotFoundException('Environment not found');
    return env;
  }

  /** FR-DEPLOY-6: only devops_engineer / platform_admin may deploy to a production environment. */
  private assertMayDeploy(user: AuthUser, isProduction: boolean) {
    const privileged = user.roles.includes('platform_admin') || user.roles.includes('devops_engineer');
    if (isProduction && !privileged) throw new ForbiddenException('Deploying to production requires devops_engineer or platform_admin');
  }

  @Get('deployments')
  @Roles('platform_admin', 'devops_engineer', 'developer', 'auditor')
  @ProjectAccess('read')
  async list(@Param('projectId') projectId: string, @Param('envId') envId: string) {
    await this.env(projectId, envId);
    return this.prisma.deployment.findMany({
      where: { environmentId: envId }, orderBy: { startedAt: 'desc' }, take: 50,
      select: {
        id: true, status: true, commitSha: true, imageRef: true, triggerSource: true, triggeredById: true,
        restoredFromId: true, failureReason: true, startedAt: true, finishedAt: true,
      },
    });
  }

  @Get('deployments/:deploymentId')
  @Roles('platform_admin', 'devops_engineer', 'developer', 'auditor')
  @ProjectAccess('read')
  async get(@Param('projectId') projectId: string, @Param('envId') envId: string, @Param('deploymentId') id: string) {
    await this.env(projectId, envId);
    const d = await this.prisma.deployment.findFirst({ where: { id, environmentId: envId } });
    if (!d) throw new NotFoundException('Deployment not found');
    return d;
  }

  @Post('deployments')
  @Roles('platform_admin', 'devops_engineer', 'developer')
  @ProjectAccess('read')
  @Audited({ action: 'deployment.trigger', targetType: 'deployment' })
  async trigger(
    @Param('projectId') projectId: string, @Param('envId') envId: string, @Body() dto: TriggerDto,
    @CurrentUser() user: AuthUser, @Headers('idempotency-key') idem?: string,
  ) {
    const env = await this.env(projectId, envId);
    this.assertMayDeploy(user, env.isProduction);
    const repo = imageRepoFor(env);
    if (!repo) throw new BadRequestException('Environment has no imageRepo or project githubRepo');
    // An explicit imageRef must still come from THIS environment's repository: never an arbitrary image.
    if (dto.imageRef && !dto.imageRef.startsWith(`${repo}:`)) throw new BadRequestException(`imageRef must be in ${repo}`);
    const imageRef = dto.imageRef ?? `${repo}:${dto.commitSha}`;
    const { deployment } = await this.svc.create({
      environmentId: env.id, commitSha: dto.commitSha, imageRef, source: 'manual', triggeredById: user.id,
      idempotencyKey: idem ? `manual:${env.id}:${idem.slice(0, 100)}` : undefined,
    });
    return deployment;
  }

  /** FR-DEPLOY-4: one-click rollback to a previous successful deployment of THIS environment. Runs through the same health-gated pipeline. */
  @Post('deployments/:deploymentId/rollback')
  @Roles('platform_admin', 'devops_engineer', 'developer')
  @ProjectAccess('read')
  @Audited({ action: 'deployment.rollback', targetType: 'deployment', targetParam: 'deploymentId' })
  async rollback(
    @Param('projectId') projectId: string, @Param('envId') envId: string, @Param('deploymentId') id: string,
    @CurrentUser() user: AuthUser,
  ) {
    const env = await this.env(projectId, envId);
    this.assertMayDeploy(user, env.isProduction);
    const target = await this.prisma.deployment.findFirst({ where: { id, environmentId: envId, status: 'SUCCESS' } });
    if (!target || !target.imageRef) throw new NotFoundException('No successful deployment with that id in this environment');
    const { deployment } = await this.svc.create({
      environmentId: env.id, commitSha: target.commitSha ?? '', imageRef: target.imageRef, source: 'rollback',
      triggeredById: user.id, restoredFromId: target.id,
    });
    return deployment;
  }
}

/** GitHub App webhook (FR-DEPLOY-1). Authenticated solely by the HMAC signature, never by a user token. */
@Controller('webhooks')
export class WebhooksController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly svc: DeploymentsService,
    private readonly audit: AuditService,
  ) {}

  @Post('github')
  @Public()
  async github(
    @Req() req: { rawBody?: Buffer; ip?: string },
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Headers('x-github-event') event: string | undefined,
    @Headers('x-github-delivery') delivery: string | undefined,
    @Body() body: any,
  ) {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) throw new ForbiddenException('Webhook not configured');
    if (!req.rawBody || !verifyGithubSignature(secret, req.rawBody, signature)) {
      await this.audit.record({ actorName: 'github', action: 'webhook.rejected', result: 'DENIED', sourceIp: req.ip, metadata: { event } });
      throw new ForbiddenException('Invalid signature');
    }
    if (event === 'ping') return { ok: true };
    // Deploy only when the project's own CI has finished building the image: `workflow_run` / completed / success.
    const wanted = process.env.GITHUB_DEPLOY_WORKFLOW ?? 'Build image';
    const run = body?.workflow_run;
    if (event !== 'workflow_run' || body?.action !== 'completed' || run?.conclusion !== 'success' || run?.name !== wanted) {
      return { ignored: true };
    }
    const repoName: unknown = body?.repository?.full_name;
    const sha: unknown = run?.head_sha;
    const branch: unknown = run?.head_branch;
    if (typeof repoName !== 'string' || typeof branch !== 'string' || typeof sha !== 'string' || !COMMIT.test(sha) || !delivery) {
      throw new BadRequestException('Malformed payload');
    }

    // Several projects may link the same repository; a successful build is deployed to each one's environment on that branch.
    const projects = await this.prisma.project.findMany({ where: { githubRepo: { equals: repoName, mode: 'insensitive' } }, orderBy: { createdAt: 'asc' } });
    if (projects.length === 0) return { ignored: true };
    const created: string[] = [];
    const envs = (
      await this.prisma.environment.findMany({ where: { projectId: { in: projects.map((p) => p.id) }, branch } })
    ).map((env) => ({ env, project: projects.find((p) => p.id === env.projectId)! }));
    for (const { env, project } of envs) {
      const repo = imageRepoFor({ ...env, project });
      if (!repo) continue;
      let result: Awaited<ReturnType<DeploymentsService['create']>>;
      try {
        result = await this.svc.create({
          environmentId: env.id, commitSha: sha, imageRef: `${repo}:${sha}`, source: 'webhook',
          idempotencyKey: `gh:${delivery}:${env.id}`,
        });
      } catch (e) {
        if (e instanceof ConflictException) continue; // cordoned server: no new deployments, and GitHub's delivery still succeeds
        throw e;
      }
      const { deployment, created: isNew } = result;
      if (isNew) {
        created.push(deployment.id);
        await this.audit.record({
          actorName: 'github', action: 'deployment.trigger', targetType: 'deployment', targetId: deployment.id,
          result: 'SUCCESS', sourceIp: req.ip, metadata: { project: project.slug, environment: env.name, commit: sha },
        });
      }
    }
    return { deployments: created };
  }
}

class CiDeployDto {
  @IsString() @Length(1, 40) @Matches(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, { message: 'environment must be an environment name' }) environment!: string;
  @IsString() @Matches(/^[0-9a-f]{40}$/, { message: 'commitSha must be a full 40-char sha' }) commitSha!: string;
}

/**
 * FR-IAM-5: lets a project's CI trigger a deployment with an API key instead of a user session.
 * Deliberately narrow: this is the ONLY route an API key can call, it is bound to the key's own project, it needs the
 * deployments:trigger scope, it can never deploy to production (a key carries no role, and FR-DEPLOY-6 requires a
 * privileged human for production), and the image is always <env repository>:<sha>. Revoking the key stops it at once.
 */
@Controller('ci')
export class CiController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly svc: DeploymentsService,
    private readonly audit: AuditService,
  ) {}

  @Post('deployments')
  @Public()
  @HttpCode(201)
  async deploy(
    @Req() req: { ip?: string }, @Headers('x-api-key') key: string | undefined,
    @Headers('idempotency-key') idem: string | undefined, @Body() dto: CiDeployDto,
  ) {
    const deny = async (reason: string, status: 401 | 403, extra: object = {}): Promise<never> => {
      await this.audit.record({ actorName: 'api-key', action: 'apikey.rejected', result: 'DENIED', sourceIp: req.ip, metadata: { reason, ...extra } });
      throw status === 401 ? new UnauthorizedException('Invalid API key') : new ForbiddenException('This API key cannot do that');
    };
    if (!key || !key.startsWith('aegis_') || key.length > 100) return deny('malformed', 401);
    const row = await this.prisma.apiKey.findUnique({ where: { keyHash: createHash('sha256').update(key).digest('hex') }, include: { project: true } });
    if (!row) return deny('unknown', 401);
    if (row.revokedAt) return deny('revoked', 401, { keyPrefix: row.prefix });
    if (!row.scopes.includes('deployments:trigger')) return deny('missing_scope', 403, { keyPrefix: row.prefix });

    const env = await this.prisma.environment.findFirst({ where: { projectId: row.projectId, name: dto.environment } });
    if (!env) throw new NotFoundException('Environment not found');
    if (env.isProduction) return deny('production_not_allowed', 403, { keyPrefix: row.prefix, environment: env.name });
    const repo = imageRepoFor({ ...env, project: row.project });
    if (!repo) throw new BadRequestException('Environment has no imageRepo or project githubRepo');

    const { deployment, created } = await this.svc.create({
      environmentId: env.id, commitSha: dto.commitSha, imageRef: `${repo}:${dto.commitSha}`, source: 'api-key',
      triggeredById: row.userId, idempotencyKey: idem ? `key:${row.id}:${env.id}:${idem.slice(0, 100)}` : undefined,
    });
    if (created) {
      await this.prisma.apiKey.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } });
      await this.audit.record({
        actorId: row.userId, actorName: `apikey:${row.prefix}`, action: 'deployment.trigger', targetType: 'deployment', targetId: deployment.id,
        result: 'SUCCESS', sourceIp: req.ip, metadata: { project: row.project.slug, environment: env.name, commit: dto.commitSha },
      });
    }
    return { id: deployment.id, status: deployment.status, commitSha: deployment.commitSha, environment: env.name };
  }
}

@Module({
  imports: [ProjectsModule],
  controllers: [DeploymentsController, WebhooksController, CiController],
  providers: [DeploymentsService, { provide: DEPLOYMENT_QUEUE, useClass: BullDeploymentQueue }],
  exports: [DeploymentsService, DEPLOYMENT_QUEUE],
})
export class DeploymentsModule {}
