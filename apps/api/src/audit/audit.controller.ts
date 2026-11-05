import { Controller, Get, Header, Module, Global, Query } from '@nestjs/common';
import { IsDateString, IsIn, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from './audit.service';
import { auditCsv, auditWhere } from './audit-query';

class AuditFilterQuery {
  @IsOptional() @IsString() @Length(1, 100) action?: string;
  @IsOptional() @IsString() @Length(1, 100) actor?: string;
  @IsOptional() @IsString() actorId?: string;
  @IsOptional() @IsIn(['SUCCESS', 'DENIED', 'ERROR']) result?: 'SUCCESS' | 'DENIED' | 'ERROR';
  @IsOptional() @IsString() @Length(1, 60) targetType?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
}

class AuditQuery extends AuditFilterQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page: number = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) pageSize: number = 50;
}

/** An export is bounded: an auditor who needs more narrows the date range. */
export const EXPORT_LIMIT = 10_000;

/** FR-AUDIT-3: search, filter and export, read-only. There is intentionally no POST/PATCH/DELETE here. */
@Controller('audit-log')
export class AuditController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  @Get()
  @Roles('platform_admin', 'auditor')
  async list(@Query() q: AuditQuery) {
    const where = auditWhere(q);
    const [items, total] = await Promise.all([
      this.prisma.auditLogEntry.findMany({
        where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize,
      }),
      this.prisma.auditLogEntry.count({ where }),
    ]);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  /** The newest EXPORT_LIMIT matching entries as CSV. Exporting is itself recorded: who, with which filters, how many rows. */
  @Get('export')
  @Roles('platform_admin', 'auditor')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="aegisops-audit-log.csv"')
  @Header('Cache-Control', 'no-store')
  async export(@Query() q: AuditFilterQuery, @CurrentUser() user: AuthUser) {
    const rows = await this.prisma.auditLogEntry.findMany({ where: auditWhere(q), orderBy: { createdAt: 'desc' }, take: EXPORT_LIMIT });
    await this.audit.record({
      actorId: user.id, actorName: user.username, action: 'audit.export', targetType: 'audit_log', result: 'SUCCESS',
      metadata: { filters: Object.fromEntries(Object.entries(q).filter(([, v]) => v)), rows: rows.length, truncated: rows.length === EXPORT_LIMIT },
    });
    return auditCsv(rows);
  }
}

@Global()
@Module({ providers: [AuditService], controllers: [AuditController], exports: [AuditService] })
export class AuditModule {}
