import type { ReactNode } from 'react';
import Link from 'next/link';
import { Space_Grotesk, JetBrains_Mono } from 'next/font/google';
import { auth } from '@/auth';
import { signOutEverywhere } from './sign-out';
import { Nav } from './nav';
import './globals.css';

export const metadata = { title: 'AegisOps' };
// Every page is rendered per request: a statically built page cannot carry the per-request nonce the Content-Security-Policy needs.
export const dynamic = 'force-dynamic';

// Fonts are fetched from Google when the app is BUILT and then served from our own origin, so the strict Content-Security-Policy
// (font-src 'self') stays as it is and the browser makes no request to a third party.
const display = Space_Grotesk({ subsets: ['latin'], weight: ['500', '600'], display: 'swap', variable: '--font-space-grotesk' });
const mono = JetBrains_Mono({ subsets: ['latin'], weight: '400', display: 'swap', variable: '--font-jetbrains-mono' });

const Mark = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M12 2.8 19.5 6v5.6c0 4.3-3 7.4-7.5 9.2-4.5-1.8-7.5-4.9-7.5-9.2V6L12 2.8Z" />
    <path d="M9 12.2h6M12 9.2v6" />
  </svg>
);

const initials = (s: string) =>
  s.split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || '?';

export default async function RootLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  const roles: string[] = (session as any)?.roles ?? [];
  const who = session?.user ? (session.user.name ?? session.user.email ?? '') : '';
  return (
    <html lang="en" className={`${display.variable} ${mono.variable}`}>
      <body>
        {session?.user ? (
          <div className="shell">
            <aside className="side">
              <Link href="/" className="brand"><Mark /><span className="brand-word">AegisOps</span></Link>
              <Nav roles={roles} />
              <div className="who">
                <span className="avatar" aria-hidden="true">{initials(who)}</span>
                <div className="who-text">
                  <span data-testid="whoami">{who}</span>
                  <span className="role">{roles.join(', ') || 'no role'}</span>
                </div>
                <form action={signOutEverywhere}>
                  <button className="link">Sign out</button>
                </form>
              </div>
            </aside>
            <main>{children}</main>
          </div>
        ) : (
          <>
            <header className="top-brand"><Link href="/" className="brand"><Mark /><span className="brand-word">AegisOps</span></Link></header>
            <main>{children}</main>
          </>
        )}
      </body>
    </html>
  );
}
