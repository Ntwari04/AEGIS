'use server';
import { redirect } from 'next/navigation';
import { api } from '@/lib/api';
import { signOut } from '@/auth';

/**
 * Signs out everywhere (FR-IAM-7): the API refuses the tokens already issued, the dashboard's cookie is cleared, and the person is
 * sent to Keycloak to end their single-sign-on session too. Without that last step Keycloak would sign them straight back in with no
 * password for up to eight hours, which on a shared computer is no sign-out at all.
 */
export async function signOutEverywhere() {
  await api('/me/revoke', { method: 'POST' }, { redirectOn401: false }).catch(() => undefined); // best effort: still sign out if the API is unreachable
  await signOut({ redirect: false });
  const back = `${(process.env.AUTH_URL ?? '').replace(/\/$/, '')}/login`;
  const params = new URLSearchParams({ client_id: process.env.KEYCLOAK_CLIENT_ID!, post_logout_redirect_uri: back });
  redirect(`${process.env.KEYCLOAK_ISSUER}/protocol/openid-connect/logout?${params}`);
}
