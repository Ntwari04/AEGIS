/**
 * Who may open a page without being signed in. One rule, used by both Auth.js's `authorized` callback and the middleware, so the two can
 * never disagree about what is public. Everything not listed needs a usable session (default-deny).
 */
export const OPEN_PATHS = ['/login', '/api/auth', '/session-ended'] as const;

export const pathIsOpen = (pathname: string) => OPEN_PATHS.some((p) => pathname.startsWith(p));

/** A session whose refresh failed is not usable: the person must sign in again. */
export const sessionIsUsable = (session: { user?: unknown; error?: unknown } | null | undefined) =>
  !!session?.user && session.error !== 'RefreshTokenError';
