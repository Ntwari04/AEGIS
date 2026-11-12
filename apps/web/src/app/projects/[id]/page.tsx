import { notFound, redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';
import { canDeploy, canManageEnvironments, currentRoles, isPrivileged } from '@/lib/permissions';
import { Time } from '@/app/time';
import { ApiKeysCard } from './api-keys-card';
import { DatabasesCard } from './databases-card';
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
        memoryLimitMb: optional('memoryLimitMb') ? Number(optional('memoryLimitMb')) : undefined,
        cpuLimit: optional('cpuLimit') ? Number(optional('cpuLimit')) : undefined,
      }),
    }, { redirectOn401: false });
  } catch (e) {
    if (e instanceof ApiError) back(projectId, e.message);
    throw e;
  }
  back(projectId);
}

async function setSecret(projectId: string, envId: string, formData: FormData) {
  'use server';
  const name = text(formData, 'name');
  try {
    await api(
      `/projects/${encodeURIComponent(projectId)}/environments/${encodeURIComponent(envId)}/secrets/${encodeURIComponent(name)}`,
      { method: 'PUT', body: JSON.stringify({ value: String(formData.get('value') ?? '') }) },
      { redirectOn401: false },
    );
  } catch (e) {
    if (e instanceof ApiError) back(projectId, e.message);
    throw e;
  }
  back(projectId);
}

async function deleteSecret(projectId: string, envId: string, name: string) {
  'use server';
  try {
    await api(
      `/projects/${encodeURIComponent(projectId)}/environments/${encodeURIComponent(envId)}/secrets/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
      { redirectOn401: false },
    );
  } catch (e) {
    if (e instanceof ApiError) back(projectId, e.message);
    throw e;
  }
  back(projectId);
}

/** FR-INFRA-2: the API queues it; the deployer resolves the container itself and re-validates. Same role rule as deploying. */
async function control(projectId: string, envId: string, action: 'start' | 'stop' | 'restart') {
  'use server';
  try {
    await api(`/projects/${encodeURIComponent(projectId)}/environments/${encodeURIComponent(envId)}/container/${action}`, { method: 'POST' }, { redirectOn401: false });
  } catch (e) {
    if (e instanceof ApiError) back(projectId, e.message);
    throw e;
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
    }, { redirectOn401: false });
  } catch (e) {
    if (e instanceof ApiError) back(projectId, e.message);
    throw e;
  }
  back(projectId);
}

async function rollback(projectId: string, envId: string, deploymentId: string) {
  'use server';
  try {
    await api(
      `/projects/${encodeURIComponent(projectId)}/environments/${encodeURIComponent(envId)}/deployments/${encodeURIComponent(deploymentId)}/rollback`,
      { method: 'POST' },
      { redirectOn401: false },
    );
  } catch (e) {
    if (e instanceof ApiError) back(projectId, e.message);
    throw e;
  }
  back(projectId);
}

/** FR-PROJ-4: the API allows platform admins and the project's own devops owner; anyone else gets its refusal as a message. */
async function addMember(projectId: string, formData: FormData) {
  'use server';
  try {
    await api(`/projects/${encodeURIComponent(projectId)}/members`, {
      method: 'POST',
      body: JSON.stringify({ username: text(formData, 'username'), role: text(formData, 'role') === 'OWNER' ? 'OWNER' : 'MEMBER' }),
    }, { redirectOn401: false });
  } catch (e) {
    if (e instanceof ApiError) back(projectId, e.message);
    throw e;
  }
  back(projectId);
}

async function removeMember(projectId: string, userId: string) {
  'use server';
  try {
    await api(`/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' }, { redirectOn401: false });
  } catch (e) {
    if (e instanceof ApiError) back(projectId, e.message);
    throw e;
  }
  back(projectId);
}

export default async function ProjectDetail({
  params, searchParams,
}: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const { id } = await params;
  const { error } = await searchParams;
  const roles = await currentRoles();
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
  const secretsByEnv = new Map<string, { configured: boolean; items: { name: string; updatedAt: string }[] }>(
    await Promise.all(
      p.environments.map(async (e) => [
        e.id,
        await api<{ configured: boolean; items: { name: string; updatedAt: string }[] }>(
          `/projects/${encodeURIComponent(id)}/environments/${encodeURIComponent(e.id)}/secrets`,
        ).catch(() => ({ configured: false, items: [] })),
      ] as [string, { configured: boolean; items: { name: string; updatedAt: string }[] }]),
    ),
  );
  const anyInFlight = [...history.values()].some((d) => d.some((x) => x.status === 'PENDING' || x.status === 'RUNNING'));

  return (
    <>
      {anyInFlight && <meta httpEquiv="refresh" content="4" />}
      <h1 data-testid="project-name">{p.name}</h1>
      <p className="muted">{p.description ?? 'No description.'}</p>
      <nav className="jump" aria-label="On this page">
        <a href="#environments">Environments</a><a href="#databases">Databases</a><a href="#members">Members</a>
        {!roles.includes('auditor') && <a href="#api-keys">API keys</a>}
      </nav>
      {error && <p className="error" data-testid="page-error">{error}</p>}
      <div className="card">
        <strong>Repository</strong>
        <p>{p.githubRepo ?? <span className="muted">Not connected yet</span>}</p>
      </div>

      <div className="card" id="environments">
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
                    {(e.memoryLimitMb || e.cpuLimit) && <> · limits {e.memoryLimitMb ? `${e.memoryLimitMb} MB` : 'default RAM'} / {e.cpuLimit ? `${e.cpuLimit} CPU` : 'default CPU'}</>}
                  </div>
                </div>
                {lastGood && <span className="muted">live: <span className="mono">{(lastGood.commitSha ?? '').slice(0, 7) || '—'}</span></span>}
              </div>
              {lastGood && (
                <div className="inline" style={{ margin: '6px 0' }}>
                  <Link href={`/projects/${id}/environments/${e.id}/logs`} data-testid={`logs-${e.name}`}>Logs</Link>
                  {canDeploy(roles, e.isProduction) && (['restart', 'stop', 'start'] as const).map((a) => (
                    <form key={a} action={control.bind(null, id, e.id, a)}>
                      <button className="link" data-testid={`${a}-${e.name}`} style={{ marginLeft: 12 }}>{a[0].toUpperCase() + a.slice(1)}</button>
                    </form>
                  ))}
                </div>
              )}
              {canDeploy(roles, e.isProduction) && (
              <form action={deploy.bind(null, id, e.id)} className="inline">
                <div style={{ flex: 1 }}>
                  <label htmlFor={`sha-${e.id}`}>Deploy a commit (an image for this SHA must already be built)</label>
                  <input id={`sha-${e.id}`} name="commitSha" required pattern="[0-9a-fA-F]{7,64}" placeholder="commit sha" />
                </div>
                <button data-testid={`deploy-${e.name}`}>Deploy</button>
              </form>
              )}
              {deployments.length > 0 && (
                <table className="stack" data-testid={`history-${e.name}`}>
                  <thead><tr><th>Status</th><th>Commit</th><th>Source</th><th>Started</th><th /></tr></thead>
                  <tbody>
                    {deployments.map((d) => (
                      <tr key={d.id}>
                        <td data-label="Status">
                          <span className="status" data-status={d.status}>{d.status}</span>
                          {d.failureReason && <div className="error mono">{d.failureReason}</div>}
                        </td>
                        <td className="mono" data-label="Commit">{(d.commitSha ?? '').slice(0, 7) || '—'}</td>
                        <td className="muted" data-label="Source">{d.triggerSource}</td>
                        <td className="muted" data-label="Started"><Time iso={d.startedAt} /></td>
                        <td>
                          <Link href={`/projects/${id}/deployments/${d.id}?env=${e.id}`}>Logs</Link>
                          {canDeploy(roles, e.isProduction) && d.status === 'SUCCESS' && d.id !== lastGood?.id && (
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
              {(() => {
                const sec = secretsByEnv.get(e.id) ?? { configured: false, items: [] };
                const mayWrite = canDeploy(roles, e.isProduction);
                return (
                  <div data-testid={`secrets-${e.name}`} style={{ marginTop: 12 }}>
                    <strong>Secrets</strong> <span className="muted">(environment variables; values are write-only and encrypted at rest)</span>
                    {!sec.configured && <p className="error">Secret storage is not configured on this server (SECRETS_ENCRYPTION_KEY).</p>}
                    {sec.items.length === 0 ? <p className="muted">None.</p> : (
                      <table className="stack">
                        <tbody>
                          {sec.items.map((s) => (
                            <tr key={s.name}>
                              <td className="mono" data-label="Name">{s.name}</td>
                              <td className="muted" data-label="Set"><Time iso={s.updatedAt} /></td>
                              <td>{mayWrite && <form action={deleteSecret.bind(null, id, e.id, s.name)}><button className="link">Delete</button></form>}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    {mayWrite && sec.configured && (
                      <form action={setSecret.bind(null, id, e.id)} className="inline">
                        <div><label htmlFor={`sn-${e.id}`}>Name</label><input id={`sn-${e.id}`} name="name" required pattern="[A-Z_][A-Z0-9_]{0,63}" placeholder="DATABASE_URL" autoComplete="off" /></div>
                        <div><label htmlFor={`sv-${e.id}`}>Value (replaces any existing value)</label><input id={`sv-${e.id}`} name="value" type="password" required maxLength={8192} autoComplete="new-password" /></div>
                        <button data-testid={`set-secret-${e.name}`}>Save secret</button>
                      </form>
                    )}
                    {sec.items.length > 0 && <p className="muted">Changes apply to the next deployment.</p>}
                  </div>
                );
              })()}
            </section>
          );
        })}
      </div>

      <DatabasesCard projectId={id} environments={p.environments} roles={roles} />

      {canManageEnvironments(roles) && (
      <details className="card fold" open={p.environments.length === 0}>
      <summary>Add an environment</summary>
      <form action={createEnvironment.bind(null, id)}>
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
          <div>
            <label htmlFor="env-mem">Memory limit, MB (optional)</label>
            <input id="env-mem" name="memoryLimitMb" type="number" min={64} max={65536} placeholder="default" />
          </div>
          <div>
            <label htmlFor="env-cpu">CPU limit, cores (optional)</label>
            <input id="env-cpu" name="cpuLimit" type="number" step="0.1" min={0.1} max={64} placeholder="default" />
          </div>
        </div>
        <label className="check"><input type="checkbox" name="isProduction" /> Production environment</label>
        <button data-testid="add-environment">Add environment</button>
      </form>
      </details>
      )}

      <div className="card" id="members" data-testid="members-card">
        <strong>Members</strong>{' '}
        <span className="muted">(who can see this project and deploy to it; a person must have signed in once before they can be added)</span>
        <table data-testid="members-table" className="stack">
          <tbody>
            {p.members.map((m) => (
              <tr key={m.userId} data-testid={`member-${m.user.username}`}>
                <td data-label="Person">{m.user.username}</td>
                <td className="muted" data-label="Role">{m.role}</td>
                <td>{isPrivileged(roles) && <form action={removeMember.bind(null, id, m.userId)}><button className="link" data-testid={`remove-${m.user.username}`}>Remove</button></form>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {isPrivileged(roles) && (
          <details className="fold" open={p.members.length === 0}>
            <summary>Add a member</summary>
            <form action={addMember.bind(null, id)} className="inline">
              <div><label htmlFor="member-username">Username</label><input id="member-username" name="username" required maxLength={100} autoComplete="off" /></div>
              <div>
                <label htmlFor="member-role">Role in this project</label>
                <select id="member-role" name="role" defaultValue="MEMBER"><option value="MEMBER">Member</option><option value="OWNER">Owner (can manage members)</option></select>
              </div>
              <button data-testid="add-member">Add member</button>
            </form>
          </details>
        )}
      </div>

      {!roles.includes('auditor') && <ApiKeysCard projectId={id} />}
    </>
  );
}
