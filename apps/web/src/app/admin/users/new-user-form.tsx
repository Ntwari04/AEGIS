'use client';
import { useActionState } from 'react';
import { createUser, type UserActionState } from './users-actions';
import { SecretNote } from './secret-note';

const ROLES = [
  { value: 'developer', label: 'Developer: sees and deploys their own projects' },
  { value: 'devops_engineer', label: 'DevOps engineer: manages projects and infrastructure (needs MFA)' },
  { value: 'auditor', label: 'Auditor: read-only access to everything, including the audit log' },
  { value: 'platform_admin', label: 'Platform admin: everything, including this screen (needs MFA)' },
];

export function NewUserForm() {
  const [state, action, pending] = useActionState<UserActionState, FormData>(createUser, {});
  return (
    <>
      <details className="card fold" data-testid="new-user-fold">
        <summary>Add a person</summary>
        <form action={action} className="grid2">
          <div>
            <label htmlFor="nu-username">Username (lower-case letters, digits, dot, dash, underscore)</label>
            <input id="nu-username" name="username" required minLength={3} maxLength={39} pattern="[a-z0-9][a-z0-9._\-]{2,38}" autoComplete="off" autoCapitalize="none" />
          </div>
          <div>
            <label htmlFor="nu-email">Email</label>
            <input id="nu-email" name="email" type="email" required maxLength={120} autoComplete="off" />
          </div>
          <div>
            <label htmlFor="nu-role">Role</label>
            <select id="nu-role" name="role" defaultValue="developer">
              {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </div>
          <div><button data-testid="create-user" disabled={pending}>{pending ? 'Creating…' : 'Create person'}</button></div>
        </form>
      </details>
      {state.error && <p className="error" role="alert" data-testid="user-error">{state.error}</p>}
      {state.ok && !state.secret && <p className="ok" role="status" data-testid="user-ok">{state.ok}</p>}
      {state.secret && (
        <>
          {state.ok && <p className="ok" role="status" data-testid="user-ok">{state.ok}</p>}
          <SecretNote username={state.secret.username} password={state.secret.password} />
        </>
      )}
    </>
  );
}
