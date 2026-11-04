import { DEFAULT_RETENTION, selectKeep, selectPrune, type Candidate } from './retention';

const NOW = new Date('2026-11-04T03:00:00Z'); // a Wednesday
const daysAgo = (n: number, hour = 2) => {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() - n);
  d.setUTCHours(hour, 0, 0, 0);
  return d;
};
const nightly = (days: number): Candidate[] => Array.from({ length: days }, (_, i) => ({ id: `n${i}`, at: daysAgo(i) }));
const kept = (c: Candidate[], policy = DEFAULT_RETENTION) => [...selectKeep(c, NOW, policy)].sort();

describe('backup retention (FR-BACKUP-3: 14 daily, 8 weekly, 12 monthly)', () => {
  it('keeps every nightly backup of the last 14 days', () => {
    const k = selectKeep(nightly(14), NOW);
    expect(k.size).toBe(14);
  });

  it('keeps nothing when there is nothing', () => {
    expect(selectKeep([], NOW).size).toBe(0);
    expect(selectPrune([], NOW)).toEqual([]);
  });

  it('prunes a daily backup older than 14 days unless it is also the weekly/monthly representative', () => {
    const c = nightly(40);
    const prune = selectPrune(c, NOW).map((x) => x.id);
    // day 14..40 are outside the daily window; of those, only weekly (Mondays' newest) and monthly representatives survive
    expect(prune.length).toBeGreaterThan(0);
    expect(prune).not.toContain('n0');
    expect(prune).not.toContain('n13');
    // a day-20 backup that is the newest of its week and within 8 weeks is kept as a weekly
    const week = (n: number) => Math.floor((Math.floor(daysAgo(n).getTime() / 86_400_000) + 3) / 7);
    const newestOfWeek20 = c.filter((x) => week(Number(x.id.slice(1))) === week(20)).sort((a, b) => b.at.getTime() - a.at.getTime())[0];
    expect(prune).not.toContain(newestOfWeek20.id);
  });

  it('after a year of nightly backups the archive is bounded: ~14 daily + ~8 weekly + ~12 monthly, not 365', () => {
    const k = selectKeep(nightly(365), NOW);
    expect(k.size).toBeGreaterThanOrEqual(14 + 7);
    expect(k.size).toBeLessThanOrEqual(14 + 9 + 13);
    expect(k.size).toBeLessThan(40);
  });

  it('keeps the newest backup of each month for 12 months, and drops older months', () => {
    const c: Candidate[] = [];
    for (let m = 0; m < 16; m++) c.push({ id: `m${m}`, at: new Date(Date.UTC(2026, 10 - m, 15, 2)) }); // one per month, going back
    const k = selectKeep(c, NOW);
    expect(k.has('m0')).toBe(true);
    expect(k.has('m11')).toBe(true);   // 11 months back: inside the 12-month window
    expect(k.has('m12')).toBe(false);  // 12 months back: outside
    expect(k.has('m15')).toBe(false);
  });

  it('within a day keeps only the newest backup (a manual backup does not displace the nightly one, but the older one is prunable)', () => {
    const c: Candidate[] = [
      { id: 'old-same-day', at: daysAgo(30, 1) },
      { id: 'new-same-day', at: daysAgo(30, 20) },
    ];
    // both far outside the daily window; they share a day, week and month: only the newest represents them
    const k = selectKeep([...c, { id: 'latest', at: daysAgo(0) }], NOW);
    expect(k.has('latest')).toBe(true);
    expect(k.has('old-same-day')).toBe(false);
  });

  it('NEVER prunes the only backup, however old', () => {
    const c: Candidate[] = [{ id: 'only', at: daysAgo(900) }];
    expect(kept(c)).toEqual(['only']);
    expect(selectPrune(c, NOW)).toEqual([]);
  });

  it('always keeps the newest backup even if everything is ancient', () => {
    const c: Candidate[] = [{ id: 'a', at: daysAgo(900) }, { id: 'b', at: daysAgo(800) }];
    expect(kept(c)).toEqual(['b']);
  });

  it('is deterministic and independent of input order', () => {
    const c = nightly(60);
    const shuffled = [...c].reverse();
    expect(kept(c)).toEqual(kept(shuffled));
  });

  it('honours a custom policy', () => {
    const k = selectKeep(nightly(30), NOW, { daily: 3, weekly: 0, monthly: 0 });
    expect([...k].sort()).toEqual(['n0', 'n1', 'n2']);
  });

  it('treats a backup stamped in the future (clock skew) as today rather than discarding it', () => {
    const c: Candidate[] = [{ id: 'future', at: new Date('2026-11-05T01:00:00Z') }, { id: 'today', at: daysAgo(0) }];
    expect(selectKeep(c, NOW).has('future')).toBe(true);
  });
});
