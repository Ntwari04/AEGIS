import type { ReactNode } from 'react';
import Link from 'next/link';
import { auth, signOut } from '@/auth';
import './globals.css';

export const metadata = { title: 'AegisOps' };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const session = await auth();
  const roles: string[] = (session as any)?.roles ?? [];
  return (
    <html lang="en">
      <body>
        <header className="bar">
          <Link href="/" className="brand">AegisOps</Link>
          {session?.user && (
            <>
              <nav>
                <Link href="/projects">Projects</Link>
              </nav>
              <div className="who">
                <span data-testid="whoami">{session.user.name ?? session.user.email}</span>
                <span className="role">{roles.join(', ') || 'no role'}</span>
                <form action={async () => { 'use server'; await signOut({ redirectTo: '/login' }); }}>
                  <button className="link">Sign out</button>
                </form>
              </div>
            </>
          )}
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
