import { Injectable, Logger } from '@nestjs/common';
import { AuditResult, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditEvent {
  actorId?: string | null;
  actorName?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  result: AuditResult;
  sourceIp?: string;
  metadata?: Record<string, unknown>;
}

const SENSITIVE_KEY = /pass(word)?|secret|token|authorization|api[-_]?key|private|credential|cookie/i;

/** Removes anything secret-shaped from audit metadata (PRD 8.4: never in audit diffs). */
export function sanitizeMetadata(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth > 4) return '[truncated]';
  if (Array.isArray(value)) return value.map((v) => sanitizeMetadata(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : sanitizeMetadata(v, depth + 1);
  }
  return out;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  constructor(private readonly prisma: PrismaService) {}

  /** Append-only. An audit write failure is logged loudly but must not mask the original request outcome. */
  async record(event: AuditEvent): Promise<void> {
    try {
      await this.prisma.auditLogEntry.create({
        data: {
          actorId: event.actorId ?? null,
          actorName: event.actorName ?? null,
          action: event.action,
          targetType: event.targetType,
          targetId: event.targetId,
          result: event.result,
          sourceIp: event.sourceIp,
          metadata: event.metadata ? (sanitizeMetadata(event.metadata) as Prisma.InputJsonValue) : undefined,
        },
      });
    } catch (err) {
      this.logger.error(`AUDIT WRITE FAILED action=${event.action}: ${(err as Error).message}`);
    }
  }
}
