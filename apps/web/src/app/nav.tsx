'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** Simple 20x20 stroke icons, drawn inline so six small shapes do not need an icon library. */
const Icon = ({ children }: { children: ReactNode }) => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {children}
  </svg>
);

const ICONS = {
  grid: <Icon><rect x="3" y="3" width="5.5" height="5.5" rx="1.2" /><rect x="11.5" y="3" width="5.5" height="5.5" rx="1.2" /><rect x="3" y="11.5" width="5.5" height="5.5" rx="1.2" /><rect x="11.5" y="11.5" width="5.5" height="5.5" rx="1.2" /></Icon>,
  server: <Icon><rect x="3" y="3.5" width="14" height="5" rx="1.5" /><rect x="3" y="11.5" width="14" height="5" rx="1.5" /><path d="M6 6h.01M6 14h.01" /></Icon>,
  shield: <Icon><path d="M10 2.5 16.5 5v4.6c0 3.7-2.6 6.3-6.5 7.9-3.9-1.6-6.5-4.2-6.5-7.9V5L10 2.5Z" /><path d="m7.2 10 2 2 3.6-3.8" /></Icon>,
  list: <Icon><path d="M8 5h9M8 10h9M8 15h9" /><path d="m3 5 1 1 1.8-2M3 10l1 1 1.8-2M3 15l1 1 1.8-2" /></Icon>,
  users: <Icon><circle cx="7.5" cy="7" r="3" /><path d="M2.5 16c.4-2.8 2.4-4.5 5-4.5s4.6 1.7 5 4.5" /><circle cx="14" cy="8" r="2.2" /><path d="M13.5 11.6c2 .1 3.6 1.4 4 3.9" /></Icon>,
  brackets: <Icon><path d="M7 4 3 10l4 6M13 4l4 6-4 6" /></Icon>,
} as const;

type Item = { href: string; label: string; icon: keyof typeof ICONS; allow?: string[] };

// Who sees what is decided here once, with the same role rules the pages and the API enforce.
const ITEMS: Item[] = [
  { href: '/projects', label: 'Projects', icon: 'grid' },
  { href: '/infra', label: 'Infrastructure', icon: 'server', allow: ['platform_admin', 'devops_engineer', 'auditor'] },
  { href: '/backups', label: 'Backups', icon: 'shield', allow: ['platform_admin', 'auditor'] },
  { href: '/audit', label: 'Audit log', icon: 'list', allow: ['platform_admin', 'auditor'] },
  { href: '/admin/users', label: 'Users', icon: 'users', allow: ['platform_admin'] },
  { href: '/api/docs', label: 'API', icon: 'brackets' },
];

export function Nav({ roles }: { roles: string[] }) {
  const pathname = usePathname() ?? '';
  const on = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  return (
    <nav aria-label="Primary">
      {ITEMS.filter((i) => !i.allow || roles.some((r) => i.allow!.includes(r))).map((i) => (
        <Link key={i.href} href={i.href} aria-current={on(i.href) ? 'page' : undefined}>
          {ICONS[i.icon]}
          {i.label}
        </Link>
      ))}
    </nav>
  );
}
