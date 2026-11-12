'use server';
import { revalidatePath } from 'next/cache';
import { api, ApiError } from '@/lib/api';

/**
 * What a users-screen form reports back. A temporary password travels only in this response, to the form that asked for it:
 * never into a URL, a cookie or a log, and the API never writes it to the audit log.
 */
export type UserActionState = { ok?: string; error?: string; secret?: { username: string; password: string } };

async function run(work: () => Promise<UserActionState>): Promise<UserActionState> {
  try {
    const r = await work();
    revalidatePath('/admin/users');
    return r;
  } catch (e) {
    if (e instanceof ApiError) return { error: e.message };
    throw e;
  }
}

const post = (path: string, method = 'POST', body?: unknown) =>
  api<any>(`/admin/users${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, { redirectOn401: false });

export async function createUser(_prev: UserActionState, form: FormData): Promise<UserActionState> {
  const username = String(form.get('username') ?? '').trim().toLowerCase();
  return run(async () => {
    const r = await post('', 'POST', { username, email: String(form.get('email') ?? '').trim(), role: String(form.get('role') ?? '') });
    return { ok: `${r.username} was created as ${r.role}.`, secret: { username: r.username, password: r.temporaryPassword } };
  });
}

export async function changeRole(id: string, _prev: UserActionState, form: FormData): Promise<UserActionState> {
  return run(async () => {
    const r = await post(`/${encodeURIComponent(id)}/role`, 'PUT', { role: String(form.get('role') ?? '') });
    return { ok: `${r.username} is now ${r.role}. Their sessions were ended, so they sign in again to use it.` };
  });
}

export async function setEnabled(id: string, enabled: boolean, _prev: UserActionState): Promise<UserActionState> {
  return run(async () => {
    const r = await post(`/${encodeURIComponent(id)}/${enabled ? 'enable' : 'disable'}`);
    return { ok: enabled ? `${r.username} can sign in again.` : `${r.username} is disabled and signed out everywhere.` };
  });
}

export async function resetPassword(id: string, _prev: UserActionState): Promise<UserActionState> {
  return run(async () => {
    const r = await post(`/${encodeURIComponent(id)}/reset-password`);
    return { ok: `New temporary password for ${r.username}.`, secret: { username: r.username, password: r.temporaryPassword } };
  });
}

export async function signOutUser(id: string, _prev: UserActionState): Promise<UserActionState> {
  return run(async () => {
    const r = await post(`/${encodeURIComponent(id)}/sign-out`);
    return { ok: `${r.username} was signed out everywhere.` };
  });
}
