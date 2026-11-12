'use client';
import { useActionState } from 'react';
import { changeRole, resetPassword, setEnabled, signOutUser, type UserActionState } from './users-actions';
import { SecretNote } from './secret-note';

type Props = { id: string; username: string; role: string | null; enabled: boolean; you: boolean };

const ROLES: [string, string][] = [
  ['developer', 'Developer'], ['devops_engineer', 'DevOps engineer'], ['auditor', 'Auditor'], ['platform_admin', 'Platform admin'],
];

/** The controls for one person. Nothing here is destructive without a second look: each outcome is written beneath the row. */
export function UserActions({ id, username, role, enabled, you }: Props) {
  const [roleState, roleAction, rolePending] = useActionState<UserActionState, FormData>(changeRole.bind(null, id), {});
  const [enState, enAction, enPending] = useActionState<UserActionState>(setEnabled.bind(null, id, !enabled), {});
  const [pwState, pwAction, pwPending] = useActionState<UserActionState>(resetPassword.bind(null, id), {});
  const [outState, outAction, outPending] = useActionState<UserActionState>(signOutUser.bind(null, id), {});
  const last = [roleState, enState, pwState, outState].find((s) => s.error || s.ok);
  const secret = pwState.secret;
  return (
    <div className="user-actions" data-testid={`actions-${username}`}>
      {you ? <span className="muted">This is you: another platform admin changes your account.</span> : (
        <>
          <form action={roleAction} className="inline">
            <label htmlFor={`role-${id}`} className="sr-only">Role for {username}</label>
            <select id={`role-${id}`} name="role" defaultValue={role ?? 'developer'} data-testid={`role-select-${username}`}>
              {ROLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <button data-testid={`role-save-${username}`} disabled={rolePending}>Set role</button>
          </form>
          <div className="inline">
            <form action={enAction}><button className="link" data-testid={`${enabled ? 'disable' : 'enable'}-${username}`} disabled={enPending}>{enabled ? 'Disable' : 'Enable'}</button></form>
            <form action={pwAction}><button className="link" data-testid={`reset-${username}`} disabled={pwPending}>Reset password</button></form>
            <form action={outAction}><button className="link" data-testid={`signout-${username}`} disabled={outPending}>Sign out everywhere</button></form>
          </div>
        </>
      )}
      {last?.error && <p className="error" role="alert" data-testid={`error-${username}`}>{last.error}</p>}
      {last?.ok && !last.secret && <p className="ok" role="status" data-testid={`ok-${username}`}>{last.ok}</p>}
      {secret && <SecretNote username={secret.username} password={secret.password} />}
    </div>
  );
}
