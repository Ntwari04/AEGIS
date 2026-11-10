import type { ReactNode } from 'react';
import Link from 'next/link';
import { auth } from '@/auth';
import { signOutEverywhere } from './sign-out';
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
                {roles.some((r) => ['platform_admin', 'devops_engineer', 'auditor'].includes(r)) && <Link href="/infra">Infrastructure</Link>}
                {roles.some((r) => ['platform_admin', 'auditor'].includes(r)) && <Link href="/backups">Backups</Link>}
                {roles.some((r) => ['platform_admin', 'auditor'].includes(r)) && <Link href="/audit">Audit log</Link>}
                <Link href="/api/docs">API</Link>
              </nav>
              <div className="who">
                <span data-testid="whoami">{session.user.name ?? session.user.email}</span>
                <span className="role">{roles.join(', ') || 'no role'}</span>
                <form action={signOutEverywhere}>
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
