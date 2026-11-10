import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Header, Headers, HttpCode, HttpException, HttpStatus, Inject, Injectable,
  Module, NotFoundException, OnModuleDestroy, Param, Post, Query, Req, Res, ServiceUnavailableException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { parseCursor, streamLogs, toSse } from './log-stream';
import { Queue } from 'bullmq';
import { IsInt, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { AuditService } from '../audit/audit.service';
import { Audited } from '../audit/audit.interceptor';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, ProjectAccess, Roles } from '../auth/decorators';
import { APP_ENV, type AppEnv } from '../config/env';
import { CONTAINER_QUEUE, platformActionAllowed, type ContainerAction, type ContainerJob } from '../deployments/container-ops';
import { MonitoringClient, MonitoringModule } from '../monitoring/monitoring.controller';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectsModule } from '../projects/projects.controller';

export const CONTAINER_JOB_QUEUE = Symbol('CONTAINER_JOB_QUEUE');
export interface ContainerJobQueue {
  enqueue(job: ContainerJob): Promise<void>;
}

/** The API only ENQUEUES container actions: the deployer, the only component with Docker access, re-validates and executes them. */
@Injectable()
export class BullContainerJobQueue implements ContainerJobQueue, OnModuleDestroy {
  private readonly queue: Queue;
  constructor(@Inject(APP_ENV) env: AppEnv) {
    const u = new URL(env.redisUrl);
    this.queue = new Queue(CONTAINER_QUEUE, { connection: { host: u.hostname, port: Number(u.port || 6379), password: decodeURIComponent(u.password), lazyConnect: true } });
  }
  async enqueue(job: ContainerJob) {
    await this.queue.add(job.kind, job, { removeOnComplete: 200, removeOnFail: 200, attempts: 1 });
  }
  onModuleDestroy() {
    return this.queue.close();
  }
}

const ACTIONS: ContainerAction[] = ['start', 'stop', 'restart'];
const asAction = (a: string): ContainerAction => {
  if (!(ACTIONS as string[]).includes(a)) throw new BadRequestException('action must be start, stop or restart');
  return a as ContainerAction;
};

export class RegisterServerDto {
  @Matches(/^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/, { message: 'name must be lowercase letters, digits and hyphens' }) name!: string;
  @IsOptional() @IsString() @Length(1, 40) role?: string;
  @IsOptional() @Matches(/^[0-9a-fA-F:.]{3,45}$/, { message: 'ipAddress must be an IP address' }) ipAddress?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(4096) cpuCores?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(64) @Max(16_777_216) memoryMb?: number;
}

/** FR-INFRA-3: a server-wide action needs the server's name typed back AND a reason, both recorded in the audit log. */
export class ServerActionDto {
  @IsString() @Length(1, 60) confirm!: string;
  @IsString() @Length(10, 500) reason!: string;
}

export class PlatformContainerDto {
  @IsString() @Length(10, 500) reason!: string;
}

export class LogsQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1440) minutes: number = 60;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(500) limit: number = 200;
  @IsOptional() @IsString() @Length(1, 100) q?: string;
}

export class LogStreamQuery {
  @IsOptional() @IsString() @Length(1, 100) q?: string;
  /** How many seconds of recent history to send before going live. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(600) backlog: number = 60;
  /** Resume after this cursor (the `id` of the last line received): a reconnecting browser sends it back. */
  @IsOptional() @Matches(/^\d{16,20}$/, { message: 'since must be a log cursor' }) since?: string;
}

const intEnv = (name: string, fallback: number) => (Number.isFinite(Number(process.env[name])) && Number(process.env[name]) > 0 ? Number(process.env[name]) : fallback);
/** Live streams are cheap but not free (each polls Loki): a person gets a few, the platform a bounded number. */
const streamLimits = () => ({
  perUser: intEnv('LOG_STREAM_MAX_PER_USER', 3),
  total: intEnv('LOG_STREAM_MAX_TOTAL', 20),
  maxMs: intEnv('LOG_STREAM_MAX_SECONDS', 1800) * 1000,
  pollMs: intEnv('LOG_STREAM_POLL_MS', 2000),
  heartbeatMs: intEnv('LOG_STREAM_HEARTBEAT_MS', 15_000),
});

@Controller()
export class InfraController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly monitoring: MonitoringClient,
    @Inject(CONTAINER_JOB_QUEUE) private readonly queue: ContainerJobQueue,
  ) {}

  // ---- servers (FR-INFRA-1) ----------------------------------------------------------------------------------------

  /** v1 is one droplet: if none is registered yet, register it so there is always something to show, sized from node-exporter when known. */
  private async ensurePrimary() {
    if ((await this.prisma.server.count()) > 0) return;
    let cpuCores: number | undefined;
    let memoryMb: number | undefined;
    try {
      const [cpu, mem] = await Promise.all([
        this.monitoring.query('count(count by (cpu)(node_cpu_seconds_total{mode="idle"}))'),
        this.monitoring.query('node_memory_MemTotal_bytes'),
      ]);
      cpuCores = cpu[0] ? Math.round(cpu[0].value) : undefined;
      memoryMb = mem[0] ? Math.round(mem[0].value / 1048576) : undefined;
    } catch { /* monitoring may be down: register without sizes */ }
    await this.prisma.server.upsert({ where: { name: 'primary' }, update: {}, create: { name: 'primary', role: 'app', cpuCores, memoryMb } });
  }

  @Get('infra/servers')
  @Roles('platform_admin', 'devops_engineer', 'auditor')
  async servers() {
    await this.ensurePrimary();
    const [servers, envCounts] = await Promise.all([
      this.prisma.server.findMany({ orderBy: { createdAt: 'asc' } }),
      this.prisma.environment.groupBy({ by: ['serverId'], _count: { _all: true } }),
    ]);
    // v1 runs on ONE host: environments without an explicit server belong to the first one.
    const primaryId = servers[0]?.id;
    const countFor = (id: string) => envCounts.filter((c) => c.serverId === id || (id === primaryId && c.serverId === null)).reduce((n, c) => n + c._count._all, 0);
    let containers: { name: string; project: string; environment: string; up: boolean }[] = [];
    try {
      const up = await this.monitoring.query('aegisops_container_up');
      containers = up.map((s) => ({ name: s.metric.name ?? '', project: s.metric.project ?? '', environment: s.metric.environment ?? '', up: s.value === 1 }));
    } catch { /* monitoring unavailable: the list is simply empty */ }
    return servers.map((s) => ({
      id: s.id, name: s.name, role: s.role, ipAddress: s.ipAddress, cpuCores: s.cpuCores, memoryMb: s.memoryMb,
      cordoned: s.cordoned, cordonReason: s.cordonReason, cordonedAt: s.cordonedAt, environments: countFor(s.id),
      containers: s.id === primaryId ? containers : [],
    }));
  }

  @Post('infra/servers')
  @Roles('platform_admin')
  @Audited({ action: 'server.register', targetType: 'server' })
  async register(@Body() dto: RegisterServerDto) {
    if (await this.prisma.server.findUnique({ where: { name: dto.name } })) throw new ConflictException('A server with that name already exists');
    const s = await this.prisma.server.create({ data: { name: dto.name, role: dto.role ?? 'app', ipAddress: dto.ipAddress, cpuCores: dto.cpuCores, memoryMb: dto.memoryMb } });
    return { id: s.id, name: s.name };
  }

  private async confirmed(id: string, dto: ServerActionDto) {
    const s = await this.prisma.server.findUnique({ where: { id } });
    if (!s) throw new NotFoundException('Server not found');
    if (dto.confirm !== s.name) throw new BadRequestException('The confirmation does not match the server name');
    return s;
  }

  /** Cordon: the server accepts no NEW deployments; whatever already runs keeps running. */
  @Post('infra/servers/:id/cordon')
  @HttpCode(200)
  @Roles('platform_admin')
  async cordon(@Param('id') id: string, @Body() dto: ServerActionDto, @CurrentUser() user: AuthUser) {
    const s = await this.confirmed(id, dto);
    await this.prisma.server.update({ where: { id }, data: { cordoned: true, cordonReason: dto.reason, cordonedAt: new Date(), cordonedById: user.id } });
    await this.audit.record({ actorId: user.id, actorName: user.username, action: 'server.cordon', targetType: 'server', targetId: id, result: 'SUCCESS', metadata: { server: s.name, reason: dto.reason } });
    return { cordoned: true };
  }

  @Post('infra/servers/:id/uncordon')
  @HttpCode(200)
  @Roles('platform_admin')
  async uncordon(@Param('id') id: string, @Body() dto: ServerActionDto, @CurrentUser() user: AuthUser) {
    const s = await this.confirmed(id, dto);
    await this.prisma.server.update({ where: { id }, data: { cordoned: false, cordonReason: null, cordonedAt: null, cordonedById: null } });
    await this.audit.record({ actorId: user.id, actorName: user.username, action: 'server.uncordon', targetType: 'server', targetId: id, result: 'SUCCESS', metadata: { server: s.name, reason: dto.reason } });
    return { cordoned: false };
  }

  /** Drain: stop every managed container on a CORDONED server. Cordon first, so nothing redeploys onto it while it empties. */
  @Post('infra/servers/:id/drain')
  @HttpCode(202)
  @Roles('platform_admin')
  async drain(@Param('id') id: string, @Body() dto: ServerActionDto, @CurrentUser() user: AuthUser) {
    const s = await this.confirmed(id, dto);
    if (!s.cordoned) throw new ConflictException('Cordon the server first: a drain on a server that still accepts deployments would just be redeployed onto');
    await this.queue.enqueue({ kind: 'drain', serverId: id, requestedById: user.id, reason: dto.reason });
    await this.audit.record({ actorId: user.id, actorName: user.username, action: 'server.drain.request', targetType: 'server', targetId: id, result: 'SUCCESS', metadata: { server: s.name, reason: dto.reason } });
    return { queued: true };
  }

  // ---- container controls and logs (FR-INFRA-2) --------------------------------------------------------------------

  /** Same rule as deploying (FR-DEPLOY-6): production needs devops_engineer / platform_admin; developers act on non-production only. */
  private assertMayControl(user: AuthUser, isProduction: boolean) {
    const privileged = user.roles.includes('platform_admin') || user.roles.includes('devops_engineer');
    if (isProduction && !privileged) throw new ForbiddenException('Controlling a production container requires devops_engineer or platform_admin');
  }

  private async environment(projectId: string, envId: string) {
    const env = await this.prisma.environment.findFirst({ where: { id: envId, projectId }, include: { project: true } });
    if (!env) throw new NotFoundException('Environment not found');
    return env;
  }

  @Post('projects/:projectId/environments/:envId/container/:action')
  @HttpCode(202)
  @Roles('platform_admin', 'devops_engineer', 'developer')
  @ProjectAccess('read')
  @Audited({ action: 'container.request', targetType: 'environment', targetParam: 'envId' })
  async control(@Param('projectId') projectId: string, @Param('envId') envId: string, @Param('action') action: string, @CurrentUser() user: AuthUser) {
    const a = asAction(action);
    const env = await this.environment(projectId, envId);
    this.assertMayControl(user, env.isProduction);
    await this.queue.enqueue({ kind: 'environment', environmentId: env.id, action: a, requestedById: user.id });
    return { queued: true };
  }

  /** Platform containers: platform_admin only, a typed reason, exact names only (and critical ones can only be restarted). */
  @Post('infra/containers/:name/:action')
  @HttpCode(202)
  @Roles('platform_admin')
  @Audited({ action: 'platform.container.request', targetType: 'container', targetParam: 'name' })
  async controlPlatform(@Param('name') name: string, @Param('action') action: string, @Body() dto: PlatformContainerDto, @CurrentUser() user: AuthUser) {
    const a = asAction(action);
    const verdict = platformActionAllowed(name, a);
    if (!verdict.ok) throw new BadRequestException(verdict.why);
    await this.queue.enqueue({ kind: 'platform', name, action: a, requestedById: user.id, reason: dto.reason });
    return { queued: true };
  }

  /** Recent logs of an environment. Anyone entitled to the project may read ITS logs; the query is bound to that project and environment. */
  @Get('projects/:projectId/environments/:envId/logs')
  @Roles('platform_admin', 'devops_engineer', 'developer', 'auditor')
  @ProjectAccess('read')
  async logs(@Param('projectId') projectId: string, @Param('envId') envId: string, @Query() q: LogsQuery) {
    const env = await this.environment(projectId, envId);
    try {
      return { lines: await this.monitoring.logs(env.project.slug, env.name, { minutes: q.minutes, limit: q.limit, contains: q.q }) };
    } catch (e) {
      throw new ServiceUnavailableException(`Logs are unavailable: ${(e as Error).message}`);
    }
  }

  private readonly liveByUser = new Map<string, number>();
  private liveTotal = 0;

  /**
   * Live logs of an environment as server-sent events (FR-INFRA-2). Same access rule and the same project-bound query as the search
   * above. Heartbeats keep proxies from closing an idle stream; the stream ends after a maximum time and the browser resumes from the
   * `id` of the last line it saw, so nothing is lost or repeated across a reconnect.
   */
  @Get('projects/:projectId/environments/:envId/logs/stream')
  @Roles('platform_admin', 'devops_engineer', 'developer', 'auditor')
  @ProjectAccess('read')
  @Header('Content-Type', 'text/event-stream')
  async stream(
    @Param('projectId') projectId: string, @Param('envId') envId: string, @Query() q: LogStreamQuery,
    @Headers('last-event-id') lastEventId: string | undefined, @CurrentUser() user: AuthUser, @Req() req: Request, @Res() res: Response,
  ) {
    const env = await this.environment(projectId, envId);
    if (!process.env.LOKI_URL) throw new ServiceUnavailableException('Logs are unavailable: log search is not configured');
    const limits = streamLimits();
    if (this.liveTotal >= limits.total || (this.liveByUser.get(user.id) ?? 0) >= limits.perUser) {
      throw new HttpException(`Too many live log views open (at most ${limits.perUser} each). Close one and try again.`, HttpStatus.TOO_MANY_REQUESTS);
    }
    this.liveTotal++;
    this.liveByUser.set(user.id, (this.liveByUser.get(user.id) ?? 0) + 1);

    const ctl = new AbortController();
    req.on('close', () => ctl.abort());
    res.status(200).set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write(': connected\n\n');
    try {
      // A cursor is the id of a line the browser ALREADY HAS, so resume just after it (Loki's start is inclusive: from it, the line would repeat).
      const resumeAfter = parseCursor(q.since) ?? parseCursor(lastEventId);
      const sinceNs = resumeAfter !== null ? resumeAfter + 1n : (BigInt(Date.now()) - BigInt(q.backlog) * 1000n) * 1_000_000n;
      for await (const e of streamLogs(this.monitoring, env.project.slug, env.name, {
        sinceNs, contains: q.q, pollMs: limits.pollMs, heartbeatMs: limits.heartbeatMs, maxMs: limits.maxMs, signal: ctl.signal,
      })) {
        if (!res.write(toSse(e))) await new Promise<void>((r) => res.once('drain', r)); // a slow reader slows the stream, it does not grow a buffer
      }
    } finally {
      this.liveTotal--;
      const left = (this.liveByUser.get(user.id) ?? 1) - 1;
      if (left <= 0) this.liveByUser.delete(user.id); else this.liveByUser.set(user.id, left);
      res.end();
    }
  }
}

@Module({
  imports: [ProjectsModule, MonitoringModule],
  controllers: [InfraController],
  providers: [{ provide: CONTAINER_JOB_QUEUE, useClass: BullContainerJobQueue }],
})
export class InfraModule {}
