import { notFound } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import type { EnvironmentDto, ProjectDto } from '@aegisops/shared-types';

type Detail = ProjectDto & {
  environments: EnvironmentDto[];
  members: { userId: string; role: string; user: { username: string } }[];
};

export default async function ProjectDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let p: Detail;
  try {
    p = await api<Detail>(`/projects/${encodeURIComponent(id)}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }
  return (
    <>
      <h1 data-testid="project-name">{p.name}</h1>
      <p className="muted">{p.description ?? 'No description.'}</p>
      <div className="card">
        <strong>Repository</strong>
        <p>{p.githubRepo ?? <span className="muted">Not connected yet</span>}</p>
      </div>
      <div className="card">
        <strong>Environments</strong>
        {p.environments.length === 0 ? (
          <p className="muted">None yet.</p>
        ) : (
          <table>
            <thead><tr><th>Name</th><th>Production</th><th>Domain</th></tr></thead>
            <tbody>
              {p.environments.map((e) => (
                <tr key={e.id}><td>{e.name}</td><td>{e.isProduction ? 'yes' : 'no'}</td><td>{e.domain ?? '—'}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="card">
        <strong>Members</strong>
        <table>
          <tbody>
            {p.members.map((m) => (
              <tr key={m.userId}><td>{m.user.username}</td><td className="muted">{m.role}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
