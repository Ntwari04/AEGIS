'use server';
import { revalidatePath } from 'next/cache';
import { api, ApiError } from '@/lib/api';

export type NewKeyState = { key?: string; name?: string; error?: string };

/**
 * Creates a project-scoped CI key. The plaintext comes back once, in this action's response, and goes only to the form that
 * asked for it: never into a URL, a cookie or a log. After this it exists only as a hash (FR-IAM-5).
 */
export async function createApiKey(projectId: string, _previous: NewKeyState, formData: FormData): Promise<NewKeyState> {
  const scopes = formData.getAll('scopes').map(String);
  if (scopes.length === 0) return { error: 'Choose at least one permission for the key.' };
  try {
    const created = await api<{ key: string; name: string }>(
      `/projects/${encodeURIComponent(projectId)}/api-keys`,
      { method: 'POST', body: JSON.stringify({ name: String(formData.get('name') ?? '').trim(), scopes }) },
      { redirectOn401: false },
    );
    revalidatePath(`/projects/${projectId}`);
    return { key: created.key, name: created.name };
  } catch (e) {
    if (e instanceof ApiError) return { error: e.message };
    throw e;
  }
}

export async function revokeApiKey(projectId: string, keyId: string): Promise<void> {
  try {
    await api(`/projects/${encodeURIComponent(projectId)}/api-keys/${encodeURIComponent(keyId)}`, { method: 'DELETE' }, { redirectOn401: false });
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
  }
  revalidatePath(`/projects/${projectId}`);
}
