export const ROLES = ['platform_admin', 'devops_engineer', 'developer', 'auditor'] as const;
export type Role = (typeof ROLES)[number];

/** Roles that may see/manage every project without a project_members row (PRD 6.2 FR-DASH-2, 6.3). */
export const GLOBAL_ACCESS_ROLES: readonly Role[] = ['platform_admin', 'auditor'];

export type ProjectMemberRole = 'OWNER' | 'MEMBER';

export interface ProjectDto {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  githubRepo: string | null;
  createdAt: string;
}

export interface EnvironmentDto {
  id: string;
  projectId: string;
  name: string;
  isProduction: boolean;
  domain: string | null;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}
