export { auth as middleware } from '@/auth';

export const config = {
  // Everything except static assets; the `authorized` callback in auth.ts decides what is public.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
