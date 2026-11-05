import type { Prisma } from '@prisma/client';

export interface AuditFilter {
  /** Exact action, or a prefix when it ends with `*` (for example `authz.*`). */
  action?: string;
  /** Part of the actor's username, any case. */
  actor?: string;
  actorId?: string;
  result?: 'SUCCESS' | 'DENIED' | 'ERROR';
  targetType?: string;
  /** Inclusive lower bound and exclusive upper bound, ISO timestamps. */
  from?: string;
  to?: string;
}

export function auditWhere(f: AuditFilter): Prisma.AuditLogEntryWhereInput {
  const where: Prisma.AuditLogEntryWhereInput = {};
  if (f.action) where.action = f.action.endsWith('*') ? { startsWith: f.action.slice(0, -1) } : f.action;
  if (f.actor) where.actorName = { contains: f.actor, mode: 'insensitive' };
  if (f.actorId) where.actorId = f.actorId;
  if (f.result) where.result = f.result;
  if (f.targetType) where.targetType = f.targetType;
  if (f.from || f.to) where.createdAt = { ...(f.from ? { gte: new Date(f.from) } : {}), ...(f.to ? { lt: new Date(f.to) } : {}) };
  return where;
}

export interface AuditRow {
  createdAt: Date;
  actorName: string | null;
  actorId: string | null;
  action: string;
  result: string;
  targetType: string | null;
  targetId: string | null;
  sourceIp: string | null;
  metadata: unknown;
}

export const CSV_COLUMNS = ['time', 'actor', 'actor_id', 'action', 'result', 'target_type', 'target_id', 'source_ip', 'metadata'] as const;

/**
 * One CSV cell. Quotes and line breaks are escaped; a cell that a spreadsheet would read as a formula (= + - @ or a leading tab/CR)
 * is prefixed with an apostrophe, so an attacker-chosen username or reason cannot run in an auditor's Excel.
 */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? '' : typeof value === 'string' ? value : value instanceof Date ? value.toISOString() : JSON.stringify(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function auditCsv(rows: AuditRow[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of rows) {
    lines.push([r.createdAt, r.actorName, r.actorId, r.action, r.result, r.targetType, r.targetId, r.sourceIp, r.metadata ?? ''].map(csvCell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}
