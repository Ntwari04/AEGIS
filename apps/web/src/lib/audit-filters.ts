/** The audit-log filters a person can set on /audit. Pure, so the page and the CSV download build the same query. */
export const AUDIT_FILTER_KEYS = ['action', 'actor', 'result', 'from', 'to'] as const;
export type AuditFilters = Partial<Record<(typeof AUDIT_FILTER_KEYS)[number], string>>;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Query string for the API. The "to" date is what a person means by "up to and including that day", so it becomes the start of the next day. */
export function auditQuery(f: AuditFilters, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams();
  for (const k of AUDIT_FILTER_KEYS) {
    let v = (f[k] ?? '').trim();
    if (!v) continue;
    if (k === 'to' && DAY.test(v)) v = new Date(new Date(`${v}T00:00:00Z`).getTime() + 86_400_000).toISOString();
    if (k === 'from' && DAY.test(v)) v = `${v}T00:00:00Z`;
    p.set(k, v);
  }
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return p.toString();
}

/** Only the known filter keys, from whatever the browser sent. */
export function pickFilters(raw: Record<string, string | string[] | undefined>): AuditFilters {
  const out: AuditFilters = {};
  for (const k of AUDIT_FILTER_KEYS) {
    const v = raw[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.trim().slice(0, 100);
  }
  return out;
}
