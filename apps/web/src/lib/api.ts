import 'server-only';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getToken } from 'next-auth/jwt';

const API_URL = process.env.API_URL!;

export const SESSION_RENEWED = 'Your session was just renewed. Please submit again.';
/** What the API says when this person signed out elsewhere, or their access was changed (FR-IAM-7). Must match the API's text. */
export const API_SESSION_ENDED = 'Session ended: sign in again';
export const SESSION_ENDED = 'Your access changed or you signed out elsewhere. Reload the page to sign in again.';

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
/** The raw response, for downloads (CSV) that are not JSON. Same token handling as api(); the caller checks `ok`. */
export async function apiRaw(path: string, init: { headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<Response> {
  return fetch(`${API_URL}${path}`, { cache: 'no-store', signal: init.signal, headers: { ...init.headers, Authorization: `Bearer ${await accessToken()}` } });
}

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
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  const ended = res.status === 401 && body?.error?.message === API_SESSION_ENDED;
  // A refused token is not an expired one: the cookie must be cleared and the person sent through a fresh sign-in (which is
  // silent while their Keycloak session lives, so a role change takes effect without typing a password).
  if (ended && opts.redirectOn401 !== false) redirect('/session-ended');
  if (res.status === 401 && opts.redirectOn401 !== false) redirect('/login');
  if (!res.ok) throw new ApiError(res.status, ended ? SESSION_ENDED : res.status === 401 ? SESSION_RENEWED : (body?.error?.message ?? res.statusText));
  return body as T;
}
