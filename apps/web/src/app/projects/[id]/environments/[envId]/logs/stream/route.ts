import { NextRequest } from 'next/server';
import { apiRaw } from '@/lib/api';

/**
 * Live logs (FR-INFRA-2): the browser cannot call the API itself (the token lives in an httpOnly cookie the page's script cannot read),
 * so this forwards the event stream with the signed-in user's token. The API decides who may watch what and enforces the limits.
 * Closing the page aborts the upstream request, which ends the stream there too.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; envId: string }> }) {
  const { id, envId } = await params;
  const forward = new URLSearchParams();
  for (const k of ['q', 'backlog', 'since']) {
    const v = req.nextUrl.searchParams.get(k);
    if (v) forward.set(k, v.slice(0, 100));
  }
  const upstream = await apiRaw(
    `/projects/${encodeURIComponent(id)}/environments/${encodeURIComponent(envId)}/logs/stream?${forward}`,
    { signal: req.signal, headers: { ...(req.headers.get('last-event-id') ? { 'Last-Event-ID': req.headers.get('last-event-id')! } : {}) } },
  );
  if (!upstream.ok || !upstream.body) {
    const known = [401, 403, 404, 429, 503];
    return new Response(upstream.status === 429 ? 'Too many live log views are open. Close one and try again.' : 'Live logs are not available.', {
      status: known.includes(upstream.status) ? upstream.status : 502,
    });
  }
  return new Response(upstream.body, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      // no-transform: the server's compression must not buffer an event stream. X-Accel-Buffering: Nginx must pass it through at once.
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
