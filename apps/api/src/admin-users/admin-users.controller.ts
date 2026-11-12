import { Body, Controller, Get, HttpCode, Module, Param, Post, Put, Query, Req, ServiceUnavailableException } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsEmail, IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import type { Role } from '@aegisops/shared-types';
import { APP_ENV, AppEnv } from '../config/env';
import { CurrentUser, Roles } from '../auth/decorators';
import type { AuthUser } from '../auth/auth.types';
import { Audited } from '../audit/audit.interceptor';
import { AdminUsersService } from './admin-users.service';
import { KeycloakAdmin, PLATFORM_ROLES } from './keycloak-admin';

export class ListUsersQuery {
  @IsOptional() @IsString() @MaxLength(80) search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) first?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) max?: number;
}

export class CreateUserDto {
  @Matches(/^[a-z0-9][a-z0-9._-]{2,38}$/, { message: 'username must be 3 to 39 characters: lower-case letters, digits, dot, dash or underscore, starting with a letter or digit' })
  username!: string;
  @IsEmail() @MaxLength(120) email!: string;
  @IsIn(PLATFORM_ROLES) role!: Role;
}

export class ChangeRoleDto {
  @IsIn(PLATFORM_ROLES) role!: Role;
}

/**
 * Users and roles (the Platform Admin persona; FR-IAM-3 stays true: roles live in Keycloak, this only asks Keycloak to change them).
 * Platform admins only, every change audited with who did what to whom. A temporary password appears once in the response that
 * created or reset it, is never written to the audit log, and must be replaced at first sign-in.
 */
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly svc: AdminUsersService) {}

  @Get()
  @Roles('platform_admin')
  async list(@Query() q: ListUsersQuery, @CurrentUser() user: AuthUser) {
    if (!this.svc.configured) throw new ServiceUnavailableException('User management is not set up on this server (the Keycloak admin client is not configured)');
    return this.svc.list({ search: q.search?.trim() || undefined, first: q.first, max: q.max }, user.keycloakId);
  }

  @Post()
  @Roles('platform_admin')
  @Audited({ action: 'admin.user.create', targetType: 'user' })
  async create(@Body() dto: CreateUserDto, @Req() req: any) {
    const r = await this.svc.create(dto);
    req.auditMetadata = { username: r.username, role: r.role };
    return r;
  }

  @Put(':id/role')
  @Roles('platform_admin')
  @Audited({ action: 'admin.user.role_change', targetType: 'user', targetParam: 'id' })
  async role(@Param('id') id: string, @Body() dto: ChangeRoleDto, @CurrentUser() user: AuthUser, @Req() req: any) {
    const r = await this.svc.changeRole(id, dto.role, user.keycloakId);
    req.auditMetadata = { username: r.username, from: r.previousRoles, to: r.role };
    return { id: r.id, username: r.username, role: r.role };
  }

  @Post(':id/disable')
  @HttpCode(200)
  @Roles('platform_admin')
  @Audited({ action: 'admin.user.disable', targetType: 'user', targetParam: 'id' })
  async disable(@Param('id') id: string, @CurrentUser() user: AuthUser, @Req() req: any) {
    const r = await this.svc.setEnabled(id, false, user.keycloakId);
    req.auditMetadata = { username: r.username };
    return r;
  }

  @Post(':id/enable')
  @HttpCode(200)
  @Roles('platform_admin')
  @Audited({ action: 'admin.user.enable', targetType: 'user', targetParam: 'id' })
  async enable(@Param('id') id: string, @CurrentUser() user: AuthUser, @Req() req: any) {
    const r = await this.svc.setEnabled(id, true, user.keycloakId);
    req.auditMetadata = { username: r.username };
    return r;
  }

  @Post(':id/reset-password')
  @HttpCode(200)
  @Roles('platform_admin')
  @Audited({ action: 'admin.user.reset_password', targetType: 'user', targetParam: 'id' })
  async reset(@Param('id') id: string, @CurrentUser() user: AuthUser, @Req() req: any) {
    const r = await this.svc.resetPassword(id, user.keycloakId);
    req.auditMetadata = { username: r.username };
    return r;
  }

  @Post(':id/sign-out')
  @HttpCode(200)
  @Roles('platform_admin')
  @Audited({ action: 'admin.user.sign_out', targetType: 'user', targetParam: 'id' })
  async signOut(@Param('id') id: string, @Req() req: any) {
    const r = await this.svc.signOut(id);
    req.auditMetadata = { username: r.username };
    return r;
  }
}

@Module({
  controllers: [AdminUsersController],
  providers: [
    { provide: KeycloakAdmin, inject: [APP_ENV], useFactory: (env: AppEnv) => new KeycloakAdmin(env.keycloakAdmin) },
    AdminUsersService,
  ],
})
export class AdminUsersModule {}
