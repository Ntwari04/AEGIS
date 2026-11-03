import { notFound, redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { api, ApiError } from '@/lib/api';
import type { DeploymentDto, EnvironmentDto, ProjectDto } from '@aegisops/shared-types';

type Detail = ProjectDto & {
  environments: EnvironmentDto[];
  members: { userId: string; role: string; user: { username: string } }[];
};

const text = (f: FormData, k: string) => String(f.get(k) ?? '').trim();

function back(projectId: string, error?: string): never {
  revalidatePath(`/projects/${projectId}`);
  redirect(`/projects/${projectId}${error ? `?error=${encodeURIComponent(error)}` : ''}`);
}

async function createEnvironment(projectId: string, formData: FormData) {
  'use server';
  const optional = (k: string) => text(formData, k) || undefined;
  const port = optional('containerPort');
  try {
    await api(`/projects/${encodeURIComponent(projectId)}/environments`, {
      method: 'POST',
      body: JSON.stringify({
        name: text(formData, 'name'),
        isProduction: formData.get('isProduction') === 'on',
        branch: optional('branch'),
        domain: optional('domain'),
        containerPort: port ? Number(port) : undefined,
        healthPath: optional('healthPath'),
        imageRepo: optional('imageRepo'),
      }),
    });
  } catch (e) {
    back(projectId, e instanceof ApiError ? e.message : 'Could not create environment');
  }
  back(projectId);
}

async function deploy(projectId: string, envId: string, formData: FormData) {
  'use server';
  try {
    await api(`/projects/${encodeURIComponent(projectId)}/environments/${encodeURIComponent(envId)}/deployments`, {
      method: 'POST',
      headers: { 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ commitSha: text(formData, 'commitSha') }),
    });
  } catch (e) {
    back(projectId, e instanceof ApiError ? e.message : 'Could not start deployment');
  }
  back(projectId);
}

async function rollback(projectId: string, envId: string, deploymentId: string) {
  'use server';
  try {
    await api(
      `/projects/${encodeURIComponent(projectId)}/environments/${encodeURIComponent(envId)}/deployments/${encodeURIComponent(deploymentId)}/rollback`,
      { method: 'POST' },
    );
  } catch (e) {
    back(projectId, e instanceof ApiError ? e.message : 'Could not start rollback');
  }
  back(projectId);
}

export default async function ProjectDetail({
  params, searchParams,
}: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const { id } = await params;
  const { error } = await searchParams;
  let p: Detail;
  try {
    p = await api<Detail>(`/projects/${encodeURIComponent(id)}`);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    throw e;
  }
  const history = new Map<string, DeploymentDto[]>(
    await Promise.all(
      p.environments.map(async (e) => [
        e.id,
        await api<DeploymentDto[]>(`/projects/${encodeURIComponent(id)}/environments/${encodeURIComponent(e.id)}/deployments`).catch(() => []),
      ] as [string, DeploymentDto[]]),
    ),
  );
  const anyInFlight = [...history.values()].some((d) => d.some((x) => x.status === 'PENDING' || x.status === 'RUNNING'));

  return (
    <>
      {anyInFlight && <meta httpEquiv="refresh" content="4" />}
      <h1 data-testid="project-name">{p.name}</h1>
      <p className="muted">{p.description ?? 'No description.'}</p>
      {error && <p className="error" data-testid="page-error">{error}</p>}
      <div className="card">
        <strong>Repository</strong>
        <p>{p.githubRepo ?? <span className="muted">Not connected yet</span>}</p>
      </div>

      <div className="card">
        <strong>Environments</strong>
        {p.environments.length === 0 && <p className="muted">None yet. Add one below.</p>}
        {p.environments.map((e) => {
          const deployments = history.get(e.id) ?? [];
          const lastGood = deployments.find((d) => d.status === 'SUCCESS');
          return (
            <section key={e.id} data-testid={`env-${e.name}`} style={{ marginTop: 16 }}>
              <div className="row">
                <div>
                  <strong>{e.name}</strong> {e.isProduction && <span className="role">production</span>}
                  <div className="muted mono">
                    {e.domain ?? 'no domain'} · branch {e.branch ?? 'main'} · port {e.containerPort ?? 3000} · {e.healthPath ?? '/healthz'}
                  </div>
                </div>
                {lastGood && <span className="muted">live: <span className="mono">{(lastGood.commitSha ?? '').slice(0, 7) || '—'}</span></span>}
              </div>
              <form action={deploy.bind(null, id, e.id)} className="inline">
                <div style={{ flex: 1 }}>
                  <label htmlFor={`sha-${e.id}`}>Deploy a commit (an image for this SHA must already be built)</label>
                  <input id={`sha-${e.id}`} name="commitSha" required pattern="[0-9a-fA-F]{7,64}" placeholder="commit sha" />
                </div>
                <button data-testid={`deploy-${e.name}`}>Deploy</button>
              </form>
              {deployments.length > 0 && (
                <table data-testid={`history-${e.name}`}>
                  <thead><tr><th>Status</th><th>Commit</th><th>Source</th><th>Started</th><th /></tr></thead>
                  <tbody>
                    {deployments.map((d) => (
                      <tr key={d.id}>
                        <td>
                          <span className="status" data-status={d.status}>{d.status}</span>
                          {d.failureReason && <div className="error mono">{d.failureReason}</div>}
                        </td>
                        <td className="mono">{(d.commitSha ?? '').slice(0, 7) || '—'}</td>
                        <td className="muted">{d.triggerSource}</td>
                        <td className="muted">{new Date(d.startedAt).toLocaleString()}</td>
                        <td>
                          {d.status === 'SUCCESS' && d.id !== lastGood?.id && (
                            <form action={rollback.bind(null, id, e.id, d.id)}>
                              <button className="link">Roll back to this</button>
                            </form>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          );
        })}
      </div>

      <form action={createEnvironment.bind(null, id)} className="card">
        <strong>Add environment</strong>
        <div className="grid2">
          <div>
            <label htmlFor="env-name">Name (e.g. staging)</label>
            <input id="env-name" name="name" required pattern="[a-z0-9]([a-z0-9\-]*[a-z0-9])?" maxLength={40} />
          </div>
          <div>
            <label htmlFor="env-branch">Branch that deploys here</label>
            <input id="env-branch" name="branch" placeholder="main" />
          </div>
          <div>
            <label htmlFor="env-domain">Domain (optional)</label>
            <input id="env-domain" name="domain" placeholder="staging.localtest.me" />
          </div>
          <div>
            <label htmlFor="env-port">Container port</label>
            <input id="env-port" name="containerPort" type="number" min={1} max={65535} placeholder="3000" />
          </div>
          <div>
            <label htmlFor="env-health">Health check path</label>
            <input id="env-health" name="healthPath" placeholder="/healthz" />
          </div>
          <div>
            <label htmlFor="env-image">Image repository (default: ghcr.io/&lt;repo&gt;)</label>
            <input id="env-image" name="imageRepo" placeholder="ghcr.io/owner/repo" />
          </div>
        </div>
        <label className="check"><input type="checkbox" name="isProduction" /> Production environment</label>
        <button data-testid="add-environment">Add environment</button>
      </form>

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
