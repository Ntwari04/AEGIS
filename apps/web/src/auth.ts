import NextAuth from 'next-auth';
import Keycloak from 'next-auth/providers/keycloak';
import type { JWT } from 'next-auth/jwt';
import { ROLES, type Role } from '@aegisops/shared-types';

/**
 * OIDC Authorization Code + PKCE against Keycloak (FR-IAM-1). This app never sees a password.
 * Tokens live only in the encrypted, httpOnly Auth.js session cookie; they are never sent to the
 * browser's JavaScript. Server code reads them via lib/token.ts and calls the API on the user's behalf.
 */

const issuer = process.env.KEYCLOAK_ISSUER!;
const clientId = process.env.KEYCLOAK_CLIENT_ID!;
const clientSecret = process.env.KEYCLOAK_CLIENT_SECRET!;

function decodeRoles(accessToken: string): Role[] {
  try {
    const payload = JSON.parse(atob(accessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    const claimed: unknown[] = Array.isArray(payload.roles) ? payload.roles : [];
    return claimed.filter((r): r is Role => (ROLES as readonly unknown[]).includes(r));
  } catch {
    return [];
  }
}

async function refresh(token: JWT): Promise<JWT> {
  try {
    const res = await fetch(`${issuer}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: token.refreshToken as string,
      }),
    });
    const t = await res.json();
    if (!res.ok) throw new Error(t.error ?? 'refresh_failed');
    return {
      ...token,
      accessToken: t.access_token,
      refreshToken: t.refresh_token ?? token.refreshToken,
      expiresAt: Math.floor(Date.now() / 1000) + t.expires_in,
      roles: decodeRoles(t.access_token), // picks up role changes at the next refresh (FR-IAM-7)
      error: undefined,
    };
  } catch {
    return { ...token, error: 'RefreshTokenError' };
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Keycloak({ issuer, clientId, clientSecret, checks: ['pkce', 'state'] })],
  session: { strategy: 'jwt', maxAge: 8 * 60 * 60 }, // refresh-token ceiling is 8h in the realm
  pages: { signIn: '/login' },
  callbacks: {
    async jwt({ token, account }) {
      if (account) {
        return {
          ...token,
          accessToken: account.access_token,
          refreshToken: account.refresh_token,
          expiresAt: account.expires_at,
          roles: decodeRoles(account.access_token!),
        };
      }
      // Refresh 60s early so the in-flight request still holds a valid access token.
      if (typeof token.expiresAt === 'number' && Date.now() / 1000 < token.expiresAt - 60) return token;
      return refresh(token);
    },
    async session({ session, token }) {
      // Deliberately NOT exposing accessToken/refreshToken here: /api/auth/session is browser-readable.
      (session as any).roles = token.roles ?? [];
      (session as any).error = token.error;
      return session;
    },
    authorized({ auth: session, request }) {
      const open = ['/login', '/api/auth'].some((p) => request.nextUrl.pathname.startsWith(p));
      if (open) return true;
      return !!session?.user && (session as any).error !== 'RefreshTokenError';
    },
  },
});
