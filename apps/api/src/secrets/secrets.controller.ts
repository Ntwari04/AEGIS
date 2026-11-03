import { Body, Controller, Delete, ForbiddenException, Get, HttpCode, Module, NotFoundException, Param, Put } from '@nestjs/common';
import { IsString, Length } from 'class-validator';
import { CurrentUser, ProjectAccess, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/auth.types';
import { Audited } from '../audit/audit.interceptor';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectsModule } from '../projects/projects.controller';
import { SecretsService } from './secrets.service';

export class SetSecretDto {
  @IsString() @Length(1, 8192) value!: string;
}

/**
 * Per-environment secret env vars (FR-PROJ-3 / FR-SEC-5). Values are write-only: no endpoint ever returns one,
 * and @Audited records the action and the secret NAME (never the body). The deployer decrypts them at deploy time.
 */
@Controller('projects/:projectId/environments/:envId/secrets')
export class SecretsController {
  constructor(private readonly prisma: PrismaService, private readonly secrets: SecretsService) {}

  private async env(projectId: string, envId: string) {
    const env = await this.prisma.environment.findFirst({ where: { id: envId, projectId } });
    if (!env) throw new NotFoundException('Environment not found');
    return env;
  }

  /** Same rule as deploying (FR-DEPLOY-6): production secrets need devops_engineer / platform_admin. */
  private assertMayWrite(user: AuthUser, isProduction: boolean) {
    const privileged = user.roles.includes('platform_admin') || user.roles.includes('devops_engineer');
    if (isProduction && !privileged) throw new ForbiddenException('Changing production secrets requires devops_engineer or platform_admin');
  }

  @Get()
  @Roles('platform_admin', 'devops_engineer', 'developer', 'auditor')
  @ProjectAccess('read')
  async list(@Param('projectId') projectId: string, @Param('envId') envId: string) {
    await this.env(projectId, envId);
    return { configured: this.secrets.isConfigured(), items: await this.secrets.list(envId) };
  }

  @Put(':name')
  @Roles('platform_admin', 'devops_engineer', 'developer')
  @ProjectAccess('read')
  @Audited({ action: 'secret.set', targetType: 'environment_secret', targetParam: 'name' })
  async set(
    @Param('projectId') projectId: string, @Param('envId') envId: string, @Param('name') name: string,
    @Body() dto: SetSecretDto, @CurrentUser() user: AuthUser,
  ) {
    const env = await this.env(projectId, envId);
    this.assertMayWrite(user, env.isProduction);
    return this.secrets.set(envId, name, dto.value, user.id); // { name, updatedAt } only
  }

  @Delete(':name')
  @HttpCode(204)
  @Roles('platform_admin', 'devops_engineer', 'developer')
  @ProjectAccess('read')
  @Audited({ action: 'secret.delete', targetType: 'environment_secret', targetParam: 'name' })
  async remove(@Param('projectId') projectId: string, @Param('envId') envId: string, @Param('name') name: string, @CurrentUser() user: AuthUser) {
    const env = await this.env(projectId, envId);
    this.assertMayWrite(user, env.isProduction);
    await this.secrets.remove(envId, name);
  }
}

@Module({
  imports: [ProjectsModule],
  controllers: [SecretsController],
  providers: [SecretsService],
  exports: [SecretsService],
})
export class SecretsModule {}
