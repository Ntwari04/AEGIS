import { NextRequest } from 'next/server';
import { apiRaw } from '@/lib/api';
import { auditQuery, pickFilters } from '@/lib/audit-filters';

/**
 * CSV download of the audit log with the filters of the page that linked here. The API decides who may export (auditor and
 * platform admin) and records the export; this only forwards the request with the signed-in user's token.
 */
export async function GET(req: NextRequest) {
  const filters = pickFilters(Object.fromEntries(req.nextUrl.searchParams));
  const res = await apiRaw(`/audit-log/export?${auditQuery(filters)}`);
  if (!res.ok) return new Response('The audit log could not be exported.', { status: res.status === 401 ? 401 : res.status === 403 ? 403 : 502 });
  return new Response(res.body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="aegisops-audit-log.csv"',
      'Cache-Control': 'no-store',
    },
  });
}
