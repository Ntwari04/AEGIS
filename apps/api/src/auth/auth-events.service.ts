import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { APP_ENV, AppEnv } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { sanitizeMetadata } from '../audit/audit.service';
import { parseKeycloakEvent } from './keycloak-events';
import { authEventsState } from './auth-events.state';

export interface LogLine { ts: string; line: string }

const POLL_MS = 30_000;
const LOOKBACK_MS = 15 * 60_000; // each poll re-reads the last 15 minutes; the unique source key makes that harmless
const BACKFILL_MS = 24 * 3_600_000; // on start: whatever happened while the API was down (as far as Loki remembers)

/**
 * FR-IAM-6 / FR-IAM-7. Keycloak's own event log is copied into the audit log, and an event that changes what a person may do
 * (sign-out, role, group or account change) refuses every token issued to them before it. Reads Loki, which Promtail fills from
 * Keycloak's log, so it needs no extra Keycloak credential. Failure to read Loki never affects requests: it is reported by a metric
 * and an alert, and the next poll catches up.
 */
@Injectable()
export class AuthEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuthEventsService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly realm: string;

  constructor(private readonly prisma: PrismaService, @Inject(APP_ENV) env: AppEnv) {
    this.realm = env.keycloakIssuer.split('/').filter(Boolean).pop() ?? 'aegisops';
  }

  onModuleInit() {
    if (!process.env.LOKI_URL || process.env.KEYCLOAK_EVENTS_INGEST === 'off') return;
    authEventsState.enabled = true;
    authEventsState.lastOkSeconds = Date.now() / 1000; // not yet proven: an ingest that never works alerts ten minutes from now
    void this.tick(BACKFILL_MS);
    this.timer = setInterval(() => void this.tick(LOOKBACK_MS), POLL_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(lookbackMs: number) {
    if (this.running) return;
    this.running = true;
    try {
      const lines = await this.fetchLines(lookbackMs);
      const r = await this.ingest(lines);
      authEventsState.lastOkSeconds = Date.now() / 1000;
      if (r.inserted) this.logger.log(`copied ${r.inserted} Keycloak event(s) into the audit log, revoked tokens for ${r.revoked} person(s)`);
    } catch (e) {
      const err = e as Error & { cause?: { message?: string } };
      this.logger.warn(`Keycloak events not copied this round: ${err.name}: ${err.message || err.cause?.message || 'no detail'}`);
    } finally {
      this.running = false;
    }
  }

  private async fetchLines(lookbackMs: number): Promise<LogLine[]> {
    const end = BigInt(Date.now()) * 1_000_000n;
    const start = end - BigInt(lookbackMs) * 1_000_000n;
    const query = '{service="keycloak"} |= "org.keycloak.events"';
    const url = `${process.env.LOKI_URL}/loki/api/v1/query_range?query=${encodeURIComponent(query)}&start=${start}&end=${end}&limit=5000&direction=forward`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Loki answered ${res.status}`);
    const body = (await res.json()) as { data?: { result?: { values: [string, string][] }[] } };
    return (body.data?.result ?? []).flatMap((s) => s.values.map(([ts, line]) => ({ ts, line })));
  }

  /** Writes the events not yet in the audit log, then applies the revocations they imply. Safe to call with overlapping windows. */
  async ingest(lines: LogLine[]): Promise<{ read: number; inserted: number; revoked: number }> {
    const parsed = lines.map((l) => parseKeycloakEvent(l.ts, l.line, this.realm)).filter((e): e is NonNullable<typeof e> => !!e);
    if (parsed.length === 0) return { read: lines.length, inserted: 0, revoked: 0 };

    const seen = new Set((await this.prisma.auditLogEntry.findMany({ where: { sourceKey: { in: parsed.map((e) => e.sourceKey) } }, select: { sourceKey: true } })).map((r) => r.sourceKey));
    const fresh = parsed.filter((e) => !seen.has(e.sourceKey));
    if (fresh.length === 0) return { read: lines.length, inserted: 0, revoked: 0 };

    const subjects = [...new Set(fresh.map((e) => e.subject).filter((s): s is string => !!s))];
    const people = new Map((await this.prisma.user.findMany({ where: { keycloakId: { in: subjects } }, select: { id: true, keycloakId: true, username: true } })).map((u) => [u.keycloakId, u]));

    await this.prisma.auditLogEntry.createMany({
      skipDuplicates: true,
      data: fresh.map((e) => {
        const person = e.subject ? people.get(e.subject) : undefined;
        const byAdmin = e.action.startsWith('auth.admin.'); // the subject is who was changed, not who acted
        return {
          createdAt: e.at,
          actorId: byAdmin ? null : person?.id ?? null,
          actorName: !byAdmin && person && e.actorName === e.subject ? person.username : e.actorName,
          action: e.action, result: e.result, sourceIp: e.sourceIp, targetType: e.targetType,
          targetId: person?.id ?? e.subject ?? null,
          metadata: sanitizeMetadata(e.metadata) as Prisma.InputJsonValue,
          sourceKey: e.sourceKey,
        };
      }),
    });

    const latest = new Map<string, Date>();
    for (const e of fresh) if (e.revokes && (!latest.has(e.revokes.subject) || latest.get(e.revokes.subject)! < e.revokes.at)) latest.set(e.revokes.subject, e.revokes.at);
    let revoked = 0;
    for (const [subject, at] of latest) {
      const r = await this.prisma.user.updateMany({
        where: { keycloakId: subject, OR: [{ tokensValidAfter: null }, { tokensValidAfter: { lt: at } }] },
        data: { tokensValidAfter: at },
      });
      revoked += r.count;
    }
    return { read: lines.length, inserted: fresh.length, revoked };
  }
}
