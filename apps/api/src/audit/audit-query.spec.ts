import { auditCsv, auditWhere, csvCell, CSV_COLUMNS } from './audit-query';

describe('auditWhere', () => {
  it('is empty without filters', () => {
    expect(auditWhere({})).toEqual({});
  });

  it('treats a trailing * as a prefix and anything else as exact', () => {
    expect(auditWhere({ action: 'authz.*' })).toEqual({ action: { startsWith: 'authz.' } });
    expect(auditWhere({ action: 'project.create' })).toEqual({ action: 'project.create' });
  });

  it('matches an actor by part of the name, any case, and combines filters', () => {
    expect(auditWhere({ actor: 'AnNa', result: 'DENIED', targetType: 'project' })).toEqual({
      actorName: { contains: 'AnNa', mode: 'insensitive' }, result: 'DENIED', targetType: 'project',
    });
  });

  it('bounds the time range: from is inclusive, to is exclusive', () => {
    const w = auditWhere({ from: '2026-11-01T00:00:00Z', to: '2026-11-02T00:00:00Z' });
    expect(w.createdAt).toEqual({ gte: new Date('2026-11-01T00:00:00Z'), lt: new Date('2026-11-02T00:00:00Z') });
    expect(auditWhere({ from: '2026-11-01T00:00:00Z' }).createdAt).toEqual({ gte: new Date('2026-11-01T00:00:00Z') });
  });
});

describe('csvCell', () => {
  it('quotes commas, quotes and line breaks', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
    expect(csvCell('plain')).toBe('plain');
  });

  it('defuses spreadsheet formulas so an attacker-chosen value cannot run in an auditor\'s Excel', () => {
    for (const evil of ['=HYPERLINK("http://evil","x")', '+1+1', '-2+3', '@SUM(A1)', '\tcmd', '\rcmd']) {
      expect(csvCell(evil).replace(/^"/, '').startsWith("'")).toBe(true);
    }
    expect(csvCell('safe-value')).toBe('safe-value');
  });

  it('writes null as empty, dates as ISO and objects as JSON', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(new Date('2026-11-05T10:00:00Z'))).toBe('2026-11-05T10:00:00.000Z');
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
  });
});

describe('auditCsv', () => {
  it('has a header row and one CRLF-terminated line per entry', () => {
    const csv = auditCsv([
      { createdAt: new Date('2026-11-05T10:00:00Z'), actorName: 'anna', actorId: 'u1', action: 'project.create', result: 'SUCCESS', targetType: 'project', targetId: 'p1', sourceIp: '1.2.3.4', metadata: { slug: 'x' } },
      { createdAt: new Date('2026-11-05T10:01:00Z'), actorName: '=evil()', actorId: null, action: 'authz.project_denied', result: 'DENIED', targetType: null, targetId: null, sourceIp: null, metadata: null },
    ]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(CSV_COLUMNS.join(','));
    expect(lines).toHaveLength(4); // header, 2 rows, trailing empty
    expect(lines[1]).toContain('anna');
    expect(lines[2]).toContain("'=evil()");
  });
});
