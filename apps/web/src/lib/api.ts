import 'server-only';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getToken } from 'next-auth/jwt';

const API_URL = process.env.API_URL!;

export const SESSION_RENEWED = 'Your session was just renewed. Please submit again.';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function accessToken(): Promise<string> {
  const h = await headers();
  const token = await getToken({
    req: { headers: h } as any,
    secret: process.env.AUTH_SECRET!,
    secureCookie: (process.env.AUTH_URL ?? '').startsWith('https://'),
  });
  if (!token?.accessToken || token.error) redirect('/login');
  return token.accessToken as string;
}

/** Server-side call to the AegisOps API as the signed-in user. The API re-checks role + project access. */
/**
 * Server actions pass { redirectOn401: false }: when the access token expired between requests, the
 * middleware has already refreshed the cookie on the RESPONSE, but this request still carries the old one.
 * Redirecting to /login would throw away the user's input; the action reports it and the user retries.
 * (Never refresh here too: Keycloak rotates refresh tokens, so a second use of the old one kills the session.)
 */
export async function api<T>(path: string, init: RequestInit = {}, opts: { redirectOn401?: boolean } = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    cache: 'no-store',
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
      Authorization: `Bearer ${await accessToken()}`,
    },
  });
  if (res.status === 401 && opts.redirectOn401 !== false) redirect('/login');
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, res.status === 401 ? SESSION_RENEWED : (body?.error?.message ?? res.statusText));
  return body as T;
}
