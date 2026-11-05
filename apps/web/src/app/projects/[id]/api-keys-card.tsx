import { api } from '@/lib/api';
import { revokeApiKey } from './api-keys-actions';
import { NewKeyForm } from './new-key-form';

type Key = { id: string; name: string; prefix: string; scopes: string[]; createdAt: string; revokedAt: string | null; lastUsedAt: string | null };

/** API keys for CI (FR-IAM-5). A person sees their own keys; a platform admin sees all. Auditors have no access to keys at all. */
export async function ApiKeysCard({ projectId }: { projectId: string }) {
  const keys = await api<Key[]>(`/projects/${encodeURIComponent(projectId)}/api-keys`).catch(() => [] as Key[]);
  return (
    <div className="card" data-testid="api-keys-card">
      <strong>API keys</strong>{' '}
      <span className="muted">(let your CI trigger a deployment of this project. Stored only as a hash; revoke one the moment it leaks or its owner leaves.)</span>
      {keys.length === 0 ? <p className="muted">No keys yet.</p> : (
        <table data-testid="api-keys-table">
          <thead><tr><th>Name</th><th>Starts with</th><th>Can</th><th>Last used</th><th /></tr></thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id} data-testid={`api-key-${k.name}`}>
                <td>{k.name}</td>
                <td className="mono">{k.prefix}…</td>
                <td className="muted">{k.scopes.join(', ')}</td>
                <td className="muted">{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : 'never'}</td>
                <td>
                  {k.revokedAt
                    ? <span className="muted">revoked</span>
                    : <form action={revokeApiKey.bind(null, projectId, k.id)}><button className="link" data-testid={`revoke-${k.name}`}>Revoke</button></form>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <NewKeyForm projectId={projectId} />
    </div>
  );
}
