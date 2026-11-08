import { signOut } from '@/auth';

/**
 * The API refused this person's token because they signed out elsewhere or their access changed (FR-IAM-7). Clear the dashboard's
 * cookie and send them to sign in again. Their Keycloak session is left alone: if it is still alive the sign-in is silent and
 * brings the new roles, and if it was ended they are asked for their password.
 */
export async function GET() {
  await signOut({ redirectTo: '/login?ended=1' });
}
