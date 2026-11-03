import { IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

const SLUG = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

export class CreateProjectDto {
  @IsString() @Length(2, 80) name!: string;
  @Matches(SLUG, { message: 'slug must be lowercase letters, digits and hyphens' }) slug!: string;
  @IsOptional() @IsString() @Length(0, 500) description?: string;
  @IsOptional() @Matches(REPO, { message: 'githubRepo must look like owner/repo' }) githubRepo?: string;
}

export class UpdateProjectDto {
  @IsOptional() @IsString() @Length(2, 80) name?: string;
  @IsOptional() @IsString() @Length(0, 500) description?: string;
  @IsOptional() @Matches(REPO, { message: 'githubRepo must look like owner/repo' }) githubRepo?: string;
}

export class PageQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page: number = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize: number = 20;
}

export class AddMemberDto {
  @IsString() @Length(1, 100) username!: string;
  @IsOptional() @IsIn(['OWNER', 'MEMBER']) role?: 'OWNER' | 'MEMBER';
}

export class CreateEnvironmentDto {
  @Matches(SLUG) name!: string;
  @IsOptional() @IsBoolean() isProduction?: boolean;
  @IsOptional() @IsString() @Length(1, 100) branch?: string;
  @IsOptional() @Matches(DOMAIN, { message: 'domain must be a valid hostname' }) domain?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(65535) containerPort?: number;
  @IsOptional() @Matches(/^\/[A-Za-z0-9\/._~-]{0,100}$/, { message: 'healthPath must start with /' }) healthPath?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(64) @Max(65536) memoryLimitMb?: number;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0.1) @Max(64) cpuLimit?: number;
  @IsOptional() @Matches(/^[a-z0-9.-]+(:[0-9]+)?(\/[a-z0-9._-]+)+$/, { message: 'imageRepo must be a lowercase registry path, no tag' }) imageRepo?: string;
}

export const API_KEY_SCOPES = ['deployments:trigger', 'deployments:read'] as const;

export class CreateApiKeyDto {
  @IsString() @Length(2, 80) name!: string;
  @IsIn(API_KEY_SCOPES as unknown as string[], { each: true }) scopes!: string[];
}
