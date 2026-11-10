/**
 * The Content-Security-Policy for the dashboard (PRD 8.5), built per request around a fresh nonce.
 *
 * Scripts: only those carrying this request's nonce run (Next.js adds it to its own bootstrap scripts when it sees the policy on the
 * request), and `strict-dynamic` lets those trusted scripts load the rest of the app. There is no 'unsafe-inline' for scripts, so markup
 * an attacker manages to inject cannot execute. Styles still allow inline: React's style attributes cannot carry a nonce, and style
 * injection is a far smaller risk than script injection. Everything else is closed down to this origin.
 */
export function contentSecurityPolicy(nonce: string, production = process.env.NODE_ENV === 'production'): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${production ? '' : " 'unsafe-eval'"}`, // dev needs eval for hot reload
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'self'",
    ...(production ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}

/** 128 random bits, base64: unguessable, and different for every request. */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
