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
  branch?: string;
  containerPort?: number;
  healthPath?: string;
  imageRepo?: string | null;
  memoryLimitMb?: number | null;
  cpuLimit?: number | null;
}

export type DeploymentStatus = 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'ROLLED_BACK';

export interface DeploymentDto {
  id: string;
  status: DeploymentStatus;
  commitSha: string | null;
  imageRef: string | null;
  triggerSource: string;
  restoredFromId: string | null;
  failureReason: string | null;
  startedAt: string;
  finishedAt: string | null;
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

// ---- Monitoring overview (FR-DASH-1..4) ----

/** up / down / restarting for a running environment; none = nothing deployed yet; unknown = monitoring unreachable. */
export type ContainerState = 'up' | 'down' | 'restarting' | 'none' | 'unknown';

export interface AlertDto {
  name: string;
  severity: 'critical' | 'warning' | string;
  summary: string;
  since: string;
  project?: string;
  environment?: string;
}

export interface EnvironmentHealth {
  id: string;
  name: string;
  isProduction: boolean;
  deployment: { status: DeploymentStatus; commitSha: string | null; at: string } | null;
  state: ContainerState;
  container: string | null;
  cpuCores: number | null;
  memoryBytes: number | null;
  memoryLimitBytes: number | null;
  /** Data the environment's container has written to its own filesystem layer; null when unknown. Excludes the image and volumes. */
  diskBytes: number | null;
  restarts1h: number | null;
  uptimeSeconds: number | null;
  alerts: AlertDto[];
  /** Grafana links (FR-DASH-4). Omitted for roles that cannot open Grafana (developers). */
  links?: { dashboard: string; logs: string };
}

export interface ProjectOverview {
  id: string;
  name: string;
  slug: string;
  githubRepo: string | null;
  environments: EnvironmentHealth[];
  openAlerts: number;
}

export interface PlatformSummary {
  containersUp: number;
  containersTotal: number;
  hostMemoryUsed: number | null;
  diskUsed: number | null;
  alerts: AlertDto[];
  links?: { dashboard: string };
}

export interface MonitoringOverview {
  monitoring: 'ok' | 'unavailable';
  generatedAt: string;
  projects: ProjectOverview[];
  /** Platform-wide roll-up: platform_admin and auditor only (FR-DASH-2). */
  platform?: PlatformSummary;
}
