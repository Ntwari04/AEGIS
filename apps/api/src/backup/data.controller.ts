import {
  BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Inject, Module, NotFoundException, Param, Post, Query, Req, ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { IsString, Length, Matches } from 'class-validator';
import { Audited } from '../audit/audit.interceptor';
import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, ProjectAccess, Roles } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectsModule } from '../projects/projects.controller';
import { SecretsModule } from '../secrets/secrets.controller';
import { SecretsService } from '../secrets/secrets.service';
import { BullDataJobQueue, DATA_JOB_QUEUE, type DataJobQueue } from './data-jobs';
import { provisionNames } from './provisioning';

export class ProvisionDatabaseDto {
  @Matches(/^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/, { message: 'name must be lowercase letters, digits and hyphens' }) name!: string;
  @IsString() @Length(36, 36) environmentId!: string;
}

export class RestoreDto {
  @IsString() @Length(0, 500) reason: string = '';
}

/** FR-DB-4: the overwrite is a SEPARATE step with its own confirmation: the database's name typed back, and a recorded reason. */
export class OverwriteDto {
  @IsString() @Length(1, 100) confirm!: string;
  @IsString() @Length(10, 500) reason!: string;
}

/** Rotating the application's database password: a recorded reason (no typed name: no data is touched). */
export class RotatePasswordDto {
  @IsString() @Length(10, 500) reason!: string;
}

/** Removing a database drops its data: the database's name typed back, and a recorded reason (like the overwrite). */
export class DeprovisionDto {
  @IsString() @Length(1, 100) confirm!: string;
  @IsString() @Length(10, 500) reason!: string;
}

const readView = (b: {
  id: string; target: string; kind: string; status: string; sizeBytes: bigint | null; plainBytes: bigint | null; startedAt: Date; finishedAt: Date | null;
  error: string | null; deletedAt: Date | null; triggeredById: string | null;
}) => ({
  id: b.id, target: b.target, kind: b.kind, status: b.status,
  sizeBytes: b.sizeBytes === null ? null : Number(b.sizeBytes), plainBytes: b.plainBytes === null ? null : Number(b.plainBytes),
  startedAt: b.startedAt, finishedAt: b.finishedAt, error: b.error, expired: b.deletedAt !== null, triggeredById: b.triggeredById,
  // objectKey, sha256 and the manifest are deliberately NOT returned: the storage layout is not the dashboard's business.
});

const restoreView = (r: {
  id: string; backupJobId: string; kind: string; status: string; targetDatabase: string; startedAt: Date; finishedAt: Date | null;
  durationMs: number | null; error: string | null; reason: string | null; integrity: unknown;
}) => {
  const i = (r.integrity ?? {}) as Record<string, unknown>;
  return {
    id: r.id, backupJobId: r.backupJobId, kind: r.kind, status: r.status, targetDatabase: r.targetDatabase, startedAt: r.startedAt, finishedAt: r.finishedAt,
    durationMs: r.durationMs, error: r.error, reason: r.reason,
    integrity: r.integrity ? { ok: i.ok ?? null, tables: i.tables ?? null, rows: i.rows ?? null, withinRto: i.withinRto ?? null, previousDatabase: i.previousDatabase ?? null } : null,
  };
};

/** Database management (FR-DB-1..4) and backup history (FR-DB-3). Every action is enqueued: the API never holds the backup role or key. */
@Controller()
export class DataController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretsService,
    @Inject(DATA_JOB_QUEUE) private readonly queue: DataJobQueue,
  ) {}

  private async database(projectId: string, dbId: string) {
    const db = await this.prisma.database.findFirst({ where: { id: dbId, projectId } });
    if (!db) throw new NotFoundException('Database not found');
    return db;
  }

  // ---- provisioning (FR-DB-1) --------------------------------------------------------------------------------------

  @Get('projects/:projectId/databases')
  @Roles('platform_admin', 'devops_engineer', 'developer', 'auditor')
  @ProjectAccess('read')
  async list(@Param('projectId') projectId: string) {
    const dbs = await this.prisma.database.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } });
    // pgName / roleName are internal; the dashboard shows the label, the environment and the status.
    return dbs.map((d) => ({ id: d.id, name: d.name, environmentId: d.environmentId, status: d.status, error: d.error, createdAt: d.createdAt, decommissionedAt: d.decommissionedAt, passwordRotatedAt: d.passwordRotatedAt, rotationError: d.rotationError }));
  }

  @Post('projects/:projectId/databases')
  @HttpCode(202)
  @Roles('platform_admin', 'devops_engineer')
  @ProjectAccess('manage')
  @Audited({ action: 'database.request', targetType: 'database' })
  async provision(@Param('projectId') projectId: string, @Body() dto: ProvisionDatabaseDto, @CurrentUser() user: AuthUser) {
    // The connection string is delivered as an encrypted environment secret, so secret storage must be on.
    if (!this.secrets.isConfigured()) throw new ServiceUnavailableException('Secret storage is not configured (SECRETS_ENCRYPTION_KEY), so a database cannot be provisioned');
    const project = await this.prisma.project.findUniqueOrThrow({ where: { id: projectId } });
    const env = await this.prisma.environment.findFirst({ where: { id: dto.environmentId, projectId } });
    if (!env) throw new NotFoundException('Environment not found');
    if (await this.prisma.database.findFirst({ where: { environmentId: env.id, status: { notIn: ['FAILED', 'DECOMMISSIONED'] } } })) throw new ConflictException('That environment already has a database');
    if ((await this.secrets.list(env.id)).some((s) => s.name === 'DATABASE_URL')) throw new ConflictException('That environment already has a DATABASE_URL secret; remove it first');

    for (let attempt = 0; ; attempt++) {
      try {
        const names = provisionNames(project.slug);
        const row = await this.prisma.database.create({
          data: { projectId, environmentId: env.id, name: dto.name, ...names, status: 'PROVISIONING', createdById: user.id },
        });
        await this.queue.enqueue({ name: 'provision-db', data: { databaseId: row.id, requestedById: user.id } });
        return { id: row.id, name: row.name, environmentId: row.environmentId, status: row.status };
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          const target = String((e.meta as { target?: unknown })?.target ?? '');
          if (target.includes('name')) throw new ConflictException('A database with that name already exists in this project');
          if (attempt < 3) continue; // a random-suffix collision on pgName: pick another
        }
        throw e;
      }
    }
  }

  /**
   * Rotate the application role's password. The data worker changes it in Postgres, proves a login with it and only then replaces the
   * environment's DATABASE_URL (putting the old password back if that fails). The application keeps its open connections but must be
   * redeployed before it next connects. A platform admin or the project's devops engineer, with a recorded reason.
   */
  @Post('projects/:projectId/databases/:dbId/rotate-password')
  @HttpCode(202)
  @Roles('platform_admin', 'devops_engineer')
  @ProjectAccess('manage')
  @Audited({ action: 'database.rotate_password.request', targetType: 'database', targetParam: 'dbId' })
  async rotatePassword(@Param('projectId') projectId: string, @Param('dbId') dbId: string, @Body() dto: RotatePasswordDto, @CurrentUser() user: AuthUser, @Req() req: any) {
    const db = await this.database(projectId, dbId);
    if (db.status !== 'READY') throw new ConflictException('That database is not ready');
    req.auditMetadata = { database: db.name, reason: dto.reason, environmentId: db.environmentId };
    await this.queue.enqueue({ name: 'rotate-password', data: { databaseId: db.id, requestedById: user.id, reason: dto.reason } });
    return { queued: true };
  }

  /**
   * Remove a database (deprovisioning): platform admin only, its name typed back, a recorded reason. The data worker takes a final
   * backup first and drops nothing if that fails. The database is marked DECOMMISSIONING at once, which also stops new backups and
   * overwrites of it; its backups stay restorable into a NEW database for the retention period.
   */
  @Post('projects/:projectId/databases/:dbId/deprovision')
  @HttpCode(202)
  @Roles('platform_admin')
  @ProjectAccess('manage')
  @Audited({ action: 'database.deprovision.request', targetType: 'database', targetParam: 'dbId' })
  async deprovision(@Param('projectId') projectId: string, @Param('dbId') dbId: string, @Body() dto: DeprovisionDto, @CurrentUser() user: AuthUser, @Req() req: any) {
    const db = await this.database(projectId, dbId);
    if (dto.confirm !== db.name) throw new BadRequestException('The confirmation does not match the database name');
    if (db.status === 'DECOMMISSIONING') throw new ConflictException('That database is already being removed');
    if (db.status === 'DECOMMISSIONED') throw new ConflictException('That database was already removed');
    if (db.status === 'PROVISIONING') throw new ConflictException('That database is still being created');
    // Claims the database in one step, so two requests cannot both queue a removal.
    const claimed = await this.prisma.database.updateMany({ where: { id: db.id, status: { in: ['READY', 'FAILED'] } }, data: { status: 'DECOMMISSIONING', error: null } });
    if (claimed.count === 0) throw new ConflictException('That database changed state; reload and check it');
    req.auditMetadata = { database: db.name, reason: dto.reason, environmentId: db.environmentId };
    await this.queue.enqueue({ name: 'deprovision-db', data: { databaseId: db.id, requestedById: user.id, reason: dto.reason } });
    return { id: db.id, name: db.name, status: 'DECOMMISSIONING' };
  }

  // ---- backups (FR-DB-3) -------------------------------------------------------------------------------------------

  @Get('projects/:projectId/databases/:dbId/backups')
  @Roles('platform_admin', 'devops_engineer', 'auditor')
  @ProjectAccess('read')
  async backups(@Param('projectId') projectId: string, @Param('dbId') dbId: string) {
    const db = await this.database(projectId, dbId);
    const rows = await this.prisma.backupJob.findMany({ where: { databaseId: db.id }, orderBy: { startedAt: 'desc' }, take: 50 });
    const restores = await this.prisma.restoreJob.findMany({ where: { backupJobId: { in: rows.map((r) => r.id) } }, orderBy: { startedAt: 'desc' }, take: 50 });
    return { backups: rows.map(readView), restores: restores.map(restoreView) };
  }

  @Post('projects/:projectId/databases/:dbId/backups')
  @HttpCode(202)
  @Roles('platform_admin', 'devops_engineer')
  @ProjectAccess('manage')
  @Audited({ action: 'backup.request', targetType: 'database', targetParam: 'dbId' })
  async backupNow(@Param('projectId') projectId: string, @Param('dbId') dbId: string, @CurrentUser() user: AuthUser) {
    const db = await this.database(projectId, dbId);
    if (db.status !== 'READY') throw new ConflictException('That database is not ready');
    await this.queue.enqueue({ name: 'backup', data: { target: `db:${db.id}`, requestedById: user.id } });
    return { queued: true };
  }

  private async restorableBackup(dbId: string, backupId: string) {
    const b = await this.prisma.backupJob.findFirst({ where: { id: backupId, databaseId: dbId } });
    if (!b) throw new NotFoundException('Backup not found');
    if (b.status !== 'SUCCESS' || b.deletedAt) throw new ConflictException('That backup is not restorable (failed or expired)');
    return b;
  }

  /** Restore into a NEW database: never destructive (FR-DB-4). */
  @Post('projects/:projectId/databases/:dbId/backups/:backupId/restore')
  @HttpCode(202)
  @Roles('platform_admin', 'devops_engineer')
  @ProjectAccess('manage')
  @Audited({ action: 'backup.restore.request', targetType: 'backup', targetParam: 'backupId' })
  async restore(@Param('projectId') projectId: string, @Param('dbId') dbId: string, @Param('backupId') backupId: string, @Body() dto: RestoreDto, @CurrentUser() user: AuthUser) {
    const db = await this.database(projectId, dbId);
    const b = await this.restorableBackup(db.id, backupId);
    await this.queue.enqueue({ name: 'restore', data: { backupJobId: b.id, requestedById: user.id, reason: dto.reason || undefined } });
    return { queued: true };
  }

  /** Overwrite a LIVE database: platform_admin only, the database's name typed back, a recorded reason (FR-DB-4). */
  @Post('projects/:projectId/databases/:dbId/backups/:backupId/overwrite')
  @HttpCode(202)
  @Roles('platform_admin')
  @ProjectAccess('manage')
  @Audited({ action: 'backup.overwrite.request', targetType: 'backup', targetParam: 'backupId' })
  async overwrite(@Param('projectId') projectId: string, @Param('dbId') dbId: string, @Param('backupId') backupId: string, @Body() dto: OverwriteDto, @CurrentUser() user: AuthUser) {
    const db = await this.database(projectId, dbId);
    if (dto.confirm !== db.name) throw new BadRequestException('The confirmation does not match the database name');
    if (db.status !== 'READY') throw new ConflictException('That database is not ready');
    const b = await this.restorableBackup(db.id, backupId);
    await this.queue.enqueue({ name: 'overwrite', data: { backupJobId: b.id, requestedById: user.id, reason: dto.reason } });
    return { queued: true };
  }

  // ---- platform-wide (system databases and drills) -----------------------------------------------------------------

  /** Backup health of the system databases and the latest drills: platform admins and auditors (the Executive view). */
  @Get('backups/overview')
  @Roles('platform_admin', 'auditor')
  async overview() {
    const systemTargets = ['system:aegisops', 'system:keycloak'];
    const targets = await Promise.all(systemTargets.map(async (target) => {
      const [last, lastOk, drill] = await Promise.all([
        this.prisma.backupJob.findFirst({ where: { target, status: { in: ['SUCCESS', 'FAILED'] } }, orderBy: { startedAt: 'desc' } }),
        this.prisma.backupJob.findFirst({ where: { target, status: 'SUCCESS', deletedAt: null }, orderBy: { startedAt: 'desc' } }),
        this.prisma.restoreJob.findFirst({ where: { kind: 'DRILL', backup: { target } }, orderBy: { startedAt: 'desc' } }),
      ]);
      return { target, last: last && readView(last), lastSuccess: lastOk && readView(lastOk), lastDrill: drill && restoreView(drill) };
    }));
    const recent = await this.prisma.backupJob.findMany({ where: { target: { in: systemTargets } }, orderBy: { startedAt: 'desc' }, take: 20 });
    return { rtoSeconds: Number(process.env.BACKUP_RTO_SECONDS ?? 4 * 3600), targets, recent: recent.map(readView) };
  }

  @Post('backups/system/:name')
  @HttpCode(202)
  @Roles('platform_admin')
  @Audited({ action: 'backup.request', targetType: 'backup', targetParam: 'name' })
  async backupSystem(@Param('name') name: string, @CurrentUser() user: AuthUser) {
    if (name !== 'aegisops' && name !== 'keycloak') throw new NotFoundException('Unknown system database');
    await this.queue.enqueue({ name: 'backup', data: { target: `system:${name}`, requestedById: user.id } });
    return { queued: true };
  }

  @Post('backups/drill')
  @HttpCode(202)
  @Roles('platform_admin')
  @Audited({ action: 'backup.drill.request', targetType: 'backup' })
  async drillNow() {
    await this.queue.enqueue({ name: 'drill', data: {} });
    return { queued: true };
  }

  @Get('restores')
  @Roles('platform_admin', 'auditor')
  async restores(@Query('limit') limit?: string) {
    const take = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const rows = await this.prisma.restoreJob.findMany({ orderBy: { startedAt: 'desc' }, take });
    return rows.map(restoreView);
  }
}

@Module({
  imports: [ProjectsModule, SecretsModule],
  controllers: [DataController],
  providers: [{ provide: DATA_JOB_QUEUE, useClass: BullDataJobQueue }],
})
export class DataModule {}
