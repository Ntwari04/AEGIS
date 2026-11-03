import {
  Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, Module,
  NotFoundException, Param, Patch, Post, Query,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { CurrentUser, ProjectAccess, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/auth.types';
import { Audited } from '../audit/audit.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import {
  AddMemberDto, CreateApiKeyDto, CreateEnvironmentDto, CreateProjectDto, PageQuery, UpdateProjectDto,
} from './projects.dto';
import { ProjectAccessGuard, ProjectAccessService } from './project-access';

const ALL_ROLES = ['platform_admin', 'devops_engineer', 'developer', 'auditor'] as const;

function isUniqueViolation(e: unknown) {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

@Controller('projects')
export class ProjectsController {
  constructor(private readonly prisma: PrismaService) {}

  @Post()
  @Roles('platform_admin', 'devops_engineer')
  @Audited({ action: 'project.create', targetType: 'project' })
  async create(@Body() dto: CreateProjectDto, @CurrentUser() user: AuthUser) {
    try {
      return await this.prisma.project.create({
        data: {
          name: dto.name,
          slug: dto.slug,
          description: dto.description,
          githubRepo: dto.githubRepo,
          createdById: user.id,
          members: { create: { userId: user.id, role: 'OWNER' } },
        },
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException('A project with that slug already exists');
      throw e;
    }
  }

  @Get()
  @Roles(...ALL_ROLES)
  async list(@Query() q: PageQuery, @CurrentUser() user: AuthUser) {
    const global = user.roles.includes('platform_admin') || user.roles.includes('auditor');
    const where: Prisma.ProjectWhereInput = global ? {} : { members: { some: { userId: user.id } } };
    const [items, total] = await Promise.all([
      this.prisma.project.findMany({
        where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize,
      }),
      this.prisma.project.count({ where }),
    ]);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  @Get(':projectId')
  @Roles(...ALL_ROLES)
  @ProjectAccess('read')
  async get(@Param('projectId') projectId: string) {
    const p = await this.prisma.project.findUnique({
      where: { id: projectId },
      include: { environments: true, members: { include: { user: { select: { username: true } } } } },
    });
    if (!p) throw new NotFoundException('Project not found');
    return p;
  }

  @Patch(':projectId')
  @Roles('platform_admin', 'devops_engineer')
  @ProjectAccess('manage')
  @Audited({ action: 'project.update', targetType: 'project', targetParam: 'projectId' })
  update(@Param('projectId') projectId: string, @Body() dto: UpdateProjectDto) {
    return this.prisma.project.update({ where: { id: projectId }, data: dto });
  }

  @Delete(':projectId')
  @HttpCode(204)
  @Roles('platform_admin')
  @ProjectAccess('manage')
  @Audited({ action: 'project.delete', targetType: 'project', targetParam: 'projectId' })
  async remove(@Param('projectId') projectId: string) {
    await this.prisma.project.delete({ where: { id: projectId } });
  }

  // ---- members (FR-PROJ-4) ----

  @Get(':projectId/members')
  @Roles(...ALL_ROLES)
  @ProjectAccess('read')
  members(@Param('projectId') projectId: string) {
    return this.prisma.projectMember.findMany({
      where: { projectId },
      include: { user: { select: { id: true, username: true } } },
    });
  }

  @Post(':projectId/members')
  @Roles('platform_admin', 'devops_engineer')
  @ProjectAccess('manage')
  @Audited({ action: 'project.member.add', targetType: 'project', targetParam: 'projectId' })
  async addMember(@Param('projectId') projectId: string, @Body() dto: AddMemberDto) {
    const target = await this.prisma.user.findFirst({ where: { username: dto.username } });
    if (!target) throw new NotFoundException('User not found (they must sign in once first)');
    return this.prisma.projectMember.upsert({
      where: { projectId_userId: { projectId, userId: target.id } },
      create: { projectId, userId: target.id, role: dto.role ?? 'MEMBER' },
      update: { role: dto.role ?? 'MEMBER' },
    });
  }

  @Delete(':projectId/members/:userId')
  @HttpCode(204)
  @Roles('platform_admin', 'devops_engineer')
  @ProjectAccess('manage')
  @Audited({ action: 'project.member.remove', targetType: 'project', targetParam: 'projectId' })
  async removeMember(@Param('projectId') projectId: string, @Param('userId') userId: string) {
    await this.prisma.projectMember.deleteMany({ where: { projectId, userId } });
  }

  // ---- environments (FR-PROJ-3) ----

  @Get(':projectId/environments')
  @Roles(...ALL_ROLES)
  @ProjectAccess('read')
  environments(@Param('projectId') projectId: string) {
    return this.prisma.environment.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } });
  }

  @Post(':projectId/environments')
  @Roles('platform_admin', 'devops_engineer')
  @ProjectAccess('manage')
  @Audited({ action: 'environment.create', targetType: 'environment' })
  async createEnvironment(@Param('projectId') projectId: string, @Body() dto: CreateEnvironmentDto) {
    try {
      return await this.prisma.environment.create({ data: { projectId, ...dto } });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ConflictException('Environment name already exists in this project');
      throw e;
    }
  }

  // ---- API keys (FR-IAM-5) ----

  @Get(':projectId/api-keys')
  @Roles('platform_admin', 'devops_engineer', 'developer')
  @ProjectAccess('read')
  apiKeys(@Param('projectId') projectId: string, @CurrentUser() user: AuthUser) {
    const mine = user.roles.includes('platform_admin') ? {} : { userId: user.id };
    return this.prisma.apiKey.findMany({
      where: { projectId, ...mine },
      select: { id: true, name: true, prefix: true, scopes: true, createdAt: true, revokedAt: true, lastUsedAt: true },
    });
  }

  @Post(':projectId/api-keys')
  @Roles('platform_admin', 'devops_engineer', 'developer')
  @ProjectAccess('read')
  @Audited({ action: 'apikey.create', targetType: 'api_key' })
  async createApiKey(
    @Param('projectId') projectId: string,
    @Body() dto: CreateApiKeyDto,
    @CurrentUser() user: AuthUser,
  ) {
    const plaintext = `aegis_${randomBytes(32).toString('base64url')}`;
    const row = await this.prisma.apiKey.create({
      data: {
        name: dto.name,
        scopes: dto.scopes,
        projectId,
        userId: user.id,
        keyHash: createHash('sha256').update(plaintext).digest('hex'),
        prefix: plaintext.slice(0, 12),
      },
      select: { id: true, name: true, prefix: true, scopes: true, createdAt: true },
    });
    // The only time the plaintext exists outside the caller's hands.
    return { ...row, key: plaintext };
  }

  @Delete(':projectId/api-keys/:keyId')
  @HttpCode(204)
  @Roles('platform_admin', 'devops_engineer', 'developer')
  @ProjectAccess('read')
  @Audited({ action: 'apikey.revoke', targetType: 'api_key', targetParam: 'keyId' })
  async revokeApiKey(
    @Param('projectId') projectId: string,
    @Param('keyId') keyId: string,
    @CurrentUser() user: AuthUser,
  ) {
    const key = await this.prisma.apiKey.findFirst({ where: { id: keyId, projectId } });
    if (!key) throw new NotFoundException('API key not found');
    if (key.userId !== user.id && !user.roles.includes('platform_admin')) {
      throw new ForbiddenException('Only the key owner or a platform admin can revoke this key');
    }
    await this.prisma.apiKey.update({ where: { id: keyId }, data: { revokedAt: new Date() } });
  }
}

@Module({
  controllers: [ProjectsController],
  providers: [ProjectAccessService, ProjectAccessGuard],
  exports: [ProjectAccessService, ProjectAccessGuard],
})
export class ProjectsModule {}
