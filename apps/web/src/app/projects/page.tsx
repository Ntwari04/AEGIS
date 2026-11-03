import Link from 'next/link';
import { auth } from '@/auth';
import { api } from '@/lib/api';
import type { Paginated, ProjectDto } from '@aegisops/shared-types';

export default async function ProjectsPage() {
  const session = await auth();
  const roles: string[] = (session as any)?.roles ?? [];
  const canCreate = roles.includes('platform_admin') || roles.includes('devops_engineer');
  const { items, total } = await api<Paginated<ProjectDto>>('/projects');

  return (
    <>
      <div className="row">
        <h1>Projects</h1>
        {canCreate && <Link className="btn" href="/projects/new" data-testid="new-project">New project</Link>}
      </div>
      <div className="card">
        {total === 0 ? (
          <p className="muted" data-testid="empty">You have no projects yet.</p>
        ) : (
          <table>
            <thead><tr><th>Name</th><th>Slug</th><th>Repository</th></tr></thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.id}>
                  <td><Link href={`/projects/${p.id}`}>{p.name}</Link></td>
                  <td>{p.slug}</td>
                  <td>{p.githubRepo ?? <span className="muted">not connected</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
