import { apiRaw } from '@/lib/api';

/** The OpenAPI document as a file, for tools (Postman, client generators). Needs a signed-in session; the API decides who may read it. */
export async function GET() {
  const res = await apiRaw('/openapi.json');
  if (!res.ok) return new Response('The API description could not be loaded.', { status: res.status === 401 || res.status === 403 ? res.status : 502 });
  return new Response(res.body, {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="aegisops-openapi.json"', 'Cache-Control': 'no-store' },
  });
}
