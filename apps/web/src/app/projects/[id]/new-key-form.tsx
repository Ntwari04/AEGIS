'use client';
import { useActionState } from 'react';
import { createApiKey, type NewKeyState } from './api-keys-actions';

const SCOPES = [
  { value: 'deployments:trigger', label: 'Trigger deployments (never production)' },
  { value: 'deployments:read', label: 'Read deployments' },
];

export function NewKeyForm({ projectId }: { projectId: string }) {
  const [state, action, pending] = useActionState<NewKeyState, FormData>(createApiKey.bind(null, projectId), {});
  return (
    <>
      <form action={action} className="inline" style={{ marginTop: 12 }}>
        <div><label htmlFor="key-name">Name (for example “GitHub Actions”)</label><input id="key-name" name="name" required minLength={2} maxLength={80} autoComplete="off" /></div>
        <div>
          {SCOPES.map((s, i) => (
            <label key={s.value} className="check"><input type="checkbox" name="scopes" value={s.value} defaultChecked={i === 0} /> {s.label}</label>
          ))}
        </div>
        <button data-testid="create-api-key" disabled={pending}>{pending ? 'Creating…' : 'Create key'}</button>
      </form>
      {state.error && <p className="error" data-testid="api-key-error">{state.error}</p>}
      {state.key && (
        <div className="card" data-testid="api-key-created">
          <strong>Key “{state.name}” created. Copy it now: it is shown once and cannot be recovered.</strong>
          <p><code className="mono" data-testid="new-api-key">{state.key}</code></p>
          <p className="note">
            Send it as the <span className="mono">X-API-Key</span> header to <span className="mono">POST /api/v1/ci/deployments</span> with
            <span className="mono"> {'{"environment":"staging","commitSha":"<40-character sha>"}'}</span>. Keep it in your CI&apos;s secret store.
          </p>
        </div>
      )}
    </>
  );
}
