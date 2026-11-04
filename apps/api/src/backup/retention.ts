export interface RetentionPolicy {
  daily: number;
  weekly: number;
  monthly: number;
}

/** FR-BACKUP-3 defaults: daily kept 14 days, weekly 8 weeks, monthly 12 months. A default to tune, not a fixed requirement. */
export const DEFAULT_RETENTION: RetentionPolicy = { daily: 14, weekly: 8, monthly: 12 };

export interface Candidate {
  id: string;
  at: Date;
}

const DAY = 86_400_000;
const utcDay = (d: Date) => Math.floor(d.getTime() / DAY);
/** Monday-based week index (UTC): days since the epoch are shifted so that a week starts on Monday. 1970-01-01 was a Thursday. */
const utcWeek = (d: Date) => Math.floor((utcDay(d) + 3) / 7);
const utcMonth = (d: Date) => d.getUTCFullYear() * 12 + d.getUTCMonth();

/**
 * Which backups to KEEP (grandfather-father-son). Pure: it only decides, it never deletes.
 *
 *  - daily:   the newest backup of each of the last `daily` days
 *  - weekly:  the newest backup of each of the last `weekly` weeks
 *  - monthly: the newest backup of each of the last `monthly` months
 *  - always:  the newest backup overall, so retention can never delete the only restore point
 *
 * A backup is kept if ANY class keeps it. Backups newer than `now` are treated as "today".
 */
export function selectKeep(candidates: Candidate[], now: Date, policy: RetentionPolicy = DEFAULT_RETENTION): Set<string> {
  const keep = new Set<string>();
  if (candidates.length === 0) return keep;
  const sorted = [...candidates].sort((a, b) => b.at.getTime() - a.at.getTime()); // newest first
  keep.add(sorted[0].id);

  const newestPer = (bucket: (d: Date) => number, current: number, count: number) => {
    const seen = new Set<number>();
    for (const c of sorted) {
      const b = Math.min(bucket(c.at), current);
      if (current - b >= count) continue; // outside the window
      if (seen.has(b)) continue; // an even newer backup already represents this bucket
      seen.add(b);
      keep.add(c.id);
    }
  };
  newestPer(utcDay, utcDay(now), policy.daily);
  newestPer(utcWeek, utcWeek(now), policy.weekly);
  newestPer(utcMonth, utcMonth(now), policy.monthly);
  return keep;
}

/** Candidates that fall outside the policy: what a prune run would delete. */
export function selectPrune(candidates: Candidate[], now: Date, policy: RetentionPolicy = DEFAULT_RETENTION): Candidate[] {
  const keep = selectKeep(candidates, now, policy);
  return candidates.filter((c) => !keep.has(c.id));
}
