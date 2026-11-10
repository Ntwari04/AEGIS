import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { pathIsOpen, sessionIsUsable } from '@/lib/access';
import { contentSecurityPolicy, newNonce } from '@/lib/csp';

/**
 * Every request: (1) default-deny sign-in, (2) a fresh nonce and a Content-Security-Policy built around it.
 *
 * Auth.js runs a middleware you pass it even when its `authorized` callback says no, so the redirect to sign-in is done here, from the
 * same rule (lib/access.ts), not left to the callback.
 */
export default auth((req) => {
  const nonce = newNonce();
  const policy = contentSecurityPolicy(nonce);

  if (!pathIsOpen(req.nextUrl.pathname) && !sessionIsUsable(req.auth as any)) {
    const signIn = req.nextUrl.clone();
    signIn.pathname = '/login';
    signIn.search = '';
    signIn.searchParams.set('callbackUrl', req.nextUrl.href);
    const res = NextResponse.redirect(signIn);
    res.headers.set('Content-Security-Policy', policy);
    return res;
  }

  // The policy goes on the REQUEST too: that is how Next.js learns the nonce and stamps it on its own inline scripts.
  const headers = new Headers(req.headers);
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', policy);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set('Content-Security-Policy', policy);
  return res;
});

export const config = {
  // Everything except static assets; lib/access.ts decides what is public.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
