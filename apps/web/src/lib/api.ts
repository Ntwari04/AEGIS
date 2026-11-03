import 'server-only';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getToken } from 'next-auth/jwt';

const API_URL = process.env.API_URL!;

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
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    cache: 'no-store',
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
      Authorization: `Bearer ${await accessToken()}`,
    },
  });
  if (res.status === 401) redirect('/login');
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body?.error?.message ?? res.statusText);
  return body as T;
}
