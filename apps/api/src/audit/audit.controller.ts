import { Controller, Get, Module, Global, Query } from '@nestjs/common';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { Roles } from '../auth/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from './audit.service';

class AuditQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page: number = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) pageSize: number = 50;
  @IsOptional() @IsString() action?: string;
  @IsOptional() @IsString() actorId?: string;
}

/** FR-AUDIT-3: read-only. There is intentionally no POST/PATCH/DELETE here. */
@Controller('audit-log')
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Roles('platform_admin', 'auditor')
  async list(@Query() q: AuditQuery) {
    const where = { ...(q.action ? { action: q.action } : {}), ...(q.actorId ? { actorId: q.actorId } : {}) };
    const [items, total] = await Promise.all([
      this.prisma.auditLogEntry.findMany({
        where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize,
      }),
      this.prisma.auditLogEntry.count({ where }),
    ]);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }
}

@Global()
@Module({ providers: [AuditService], controllers: [AuditController], exports: [AuditService] })
export class AuditModule {}
