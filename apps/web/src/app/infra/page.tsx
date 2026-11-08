import { notFound, redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { api, ApiError } from '@/lib/api';
import { currentRoles } from '@/lib/permissions';

type Server = {
  id: string; name: string; role: string; ipAddress: string | null; cpuCores: number | null; memoryMb: number | null;
  cordoned: boolean; cordonReason: string | null; cordonedAt: string | null; environments: number;
  containers: { name: string; project: string; environment: string; up: boolean }[];
};

// Mirrors apps/api/src/deployments/container-ops.ts: the API and the deployer enforce these; this only shapes the form.
const CRITICAL = new Set(['aegisops-postgres', 'aegisops-redis', 'aegisops-keycloak', 'aegisops-api', 'aegisops-web', 'aegisops-nginx']);

/** Infrastructure (FR-INFRA-1..3). Read-only for devops engineers and auditors; every control is platform_admin only and typed-confirmed. */
export default async function InfraPage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const roles = await currentRoles();
  if (!roles.some((r) => ['platform_admin', 'devops_engineer', 'auditor'].includes(r))) notFound();
  const { error, ok } = await searchParams;
  const admin = roles.includes('platform_admin');
  const servers = await api<Server[]>('/infra/servers');

  async function call(path: string, body: unknown, done: string) {
    'use server';
    try {
      await api(path, { method: 'POST', body: JSON.stringify(body) }, { redirectOn401: false });
    } catch (e) {
      if (e instanceof ApiError) redirect(`/infra?error=${encodeURIComponent(e.message)}`);
      throw e;
    }
    revalidatePath('/infra');
    redirect(`/infra?ok=${encodeURIComponent(done)}`);
  }
  async function register(formData: FormData) {
    'use server';
    const num = (k: string) => (formData.get(k) ? Number(formData.get(k)) : undefined);
    await call('/infra/servers', { name: String(formData.get('name') ?? '').trim(), ipAddress: String(formData.get('ip') ?? '').trim() || undefined, cpuCores: num('cpu'), memoryMb: num('mem') }, 'Server registered.');
  }
  async function serverAction(serverId: string, action: 'cordon' | 'uncordon' | 'drain', formData: FormData) {
    'use server';
    const done = { cordon: 'Server cordoned: it accepts no new deployments.', uncordon: 'Server re-opened for deployments.', drain: 'Drain queued: managed containers on this server will be stopped.' }[action];
    await call(`/infra/servers/${encodeURIComponent(serverId)}/${action}`, { confirm: String(formData.get('confirm') ?? ''), reason: String(formData.get('reason') ?? '').trim() }, done);
  }
  async function platformAction(formData: FormData) {
    'use server';
    const name = String(formData.get('name') ?? '');
    const action = String(formData.get('action') ?? 'restart');
    await call(`/infra/containers/${encodeURIComponent(name)}/${encodeURIComponent(action)}`, { reason: String(formData.get('reason') ?? '').trim() }, `${action} queued for ${name}.`);
  }

  const platform = servers.flatMap((s) => s.containers).filter((c) => !c.project).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <>
      <h1>Infrastructure</h1>
      {error && <p className="error" data-testid="page-error">{error}</p>}
      {ok && <p className="ok" data-testid="page-ok">{ok}</p>}

      {servers.map((s) => (
        <div className="card" key={s.id} data-testid={`server-${s.name}`}>
          <div className="row">
            <div>
              <strong>{s.name}</strong> <span className="role">{s.role}</span>{' '}
              {s.cordoned && <span className="sev" data-sev="critical" data-testid="cordoned">cordoned</span>}
              <div className="muted mono">{[
                s.ipAddress ?? 'address not set',
                s.cpuCores ? `${s.cpuCores} CPU` : 'CPU not set',
                s.memoryMb ? `${Math.round(s.memoryMb / 1024 * 10) / 10} GB RAM` : 'RAM not set',
                `${s.environments} environment${s.environments === 1 ? '' : 's'}`,
              ].join(' · ')}</div>
              {s.cordoned && <div className="note">Cordoned: no new deployments{s.cordonReason ? `. Reason: ${s.cordonReason}` : ''}</div>}
            </div>
          </div>
          {s.containers.length > 0 && (
            <table>
              <thead><tr><th>Container</th><th>Belongs to</th><th>State</th></tr></thead>
              <tbody>
                {s.containers.sort((a, b) => a.name.localeCompare(b.name)).map((c) => (
                  <tr key={c.name}>
                    <td className="mono">{c.name}</td>
                    <td className="muted">{c.project ? `${c.project}/${c.environment}` : 'platform'}</td>
                    <td><span className="state" data-state={c.up ? 'up' : 'down'}>{c.up ? 'Up' : 'Down'}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {admin && (
            <details style={{ marginTop: 12 }}>
              <summary>{s.cordoned ? 'Uncordon or drain…' : 'Cordon…'}</summary>
              <form action={serverAction.bind(null, s.id, s.cordoned ? 'uncordon' : 'cordon')} className="card" style={{ marginTop: 8 }}>
                <p className="note">{s.cordoned ? 'Re-open this server for deployments.' : 'Stop accepting NEW deployments on this server. Whatever is running keeps running.'}</p>
                <label htmlFor={`c-${s.id}`}>Type the server name <span className="mono">{s.name}</span> to confirm</label>
                <input id={`c-${s.id}`} name="confirm" required autoComplete="off" />
                <label htmlFor={`r-${s.id}`}>Reason (recorded in the audit log, at least 10 characters)</label>
                <input id={`r-${s.id}`} name="reason" required minLength={10} maxLength={500} />
                <button data-testid={s.cordoned ? 'uncordon' : 'cordon'}>{s.cordoned ? 'Uncordon' : 'Cordon server'}</button>
              </form>
              {s.cordoned && (
                <form action={serverAction.bind(null, s.id, 'drain')} className="card danger" style={{ marginTop: 8 }}>
                  <strong>Drain</strong>
                  <p className="note">Stops every application container on this server. Platform services are not touched.</p>
                  <label htmlFor={`dc-${s.id}`}>Type the server name <span className="mono">{s.name}</span> to confirm</label>
                  <input id={`dc-${s.id}`} name="confirm" required autoComplete="off" />
                  <label htmlFor={`dr-${s.id}`}>Reason (recorded in the audit log)</label>
                  <input id={`dr-${s.id}`} name="reason" required minLength={10} maxLength={500} />
                  <button data-testid="drain">Drain server</button>
                </form>
              )}
            </details>
          )}
        </div>
      ))}

      {admin && (
        <>
          <form action={platformAction} className="card">
            <strong>Platform container</strong>
            <p className="note">Services the dashboard itself depends on (database, queue, API, login, proxy) can only be restarted, never stopped from here.</p>
            <div className="grid2">
              <div>
                <label htmlFor="pc-name">Container</label>
                <select id="pc-name" name="name" required>
                  {platform.map((c) => <option key={c.name} value={c.name}>{c.name}{CRITICAL.has(c.name) ? ' (restart only)' : ''}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="pc-action">Action</label>
                <select id="pc-action" name="action"><option value="restart">restart</option><option value="stop">stop (non-critical only)</option><option value="start">start (non-critical only)</option></select>
              </div>
            </div>
            <label htmlFor="pc-reason">Reason (recorded in the audit log, at least 10 characters)</label>
            <input id="pc-reason" name="reason" required minLength={10} maxLength={500} />
            <button data-testid="platform-action">Run</button>
          </form>

          <form action={register} className="card">
            <strong>Register a server</strong>
            <div className="grid2">
              <div><label htmlFor="s-name">Name</label><input id="s-name" name="name" required pattern="[a-z0-9]([a-z0-9\-]{0,38}[a-z0-9])?" /></div>
              <div><label htmlFor="s-ip">IP address (optional)</label><input id="s-ip" name="ip" /></div>
              <div><label htmlFor="s-cpu">CPU cores (optional)</label><input id="s-cpu" name="cpu" type="number" min={1} /></div>
              <div><label htmlFor="s-mem">Memory, MB (optional)</label><input id="s-mem" name="mem" type="number" min={64} /></div>
            </div>
            <button data-testid="register-server">Register server</button>
          </form>
        </>
      )}
    </>
  );
}
