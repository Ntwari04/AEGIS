import Link from 'next/link';
import { notFound } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { Time } from '@/app/time';
import { currentRoles } from '@/lib/permissions';
import { NewUserForm } from './new-user-form';
import { UserActions } from './user-actions';

type Person = {
  id: string; username: string; email: string | null; enabled: boolean; roles: string[];
  createdAt: string | null; lastSeenAt: string | null; you: boolean;
};

const PAGE = 25;
const ROLE_LABEL: Record<string, string> = {
  platform_admin: 'Platform admin', devops_engineer: 'DevOps engineer', developer: 'Developer', auditor: 'Auditor',
};

/**
 * The Platform Admin persona's "manage users and roles". Identities and roles still live in Keycloak (FR-IAM-1/3); this screen
 * asks Keycloak, through a service account that can only manage users, and every change lands in the audit log.
 */
export default async function UsersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const roles = await currentRoles();
  if (!roles.includes('platform_admin')) notFound();

  const raw = await searchParams;
  const search = typeof raw.search === 'string' ? raw.search.trim().slice(0, 80) : '';
  const page = Math.max(1, Number(typeof raw.page === 'string' ? raw.page : 1) || 1);
  const query = new URLSearchParams({ first: String((page - 1) * PAGE), max: String(PAGE), ...(search ? { search } : {}) });

  let people: Person[] = [];
  let problem: string | null = null;
  try {
    people = await api<Person[]>(`/admin/users?${query}`);
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    problem = e.message;
  }
  const link = (p: number) => `/admin/users?${new URLSearchParams({ ...(search ? { search } : {}), page: String(p) })}`;

  return (
    <>
      <div className="row"><h1>Users and roles</h1></div>
      <p className="note">
        Add people, change what they may do, and end their access. Passwords never pass through AegisOps: a new or reset account gets a
        temporary password, shown once, that its owner replaces at first sign-in. A change to someone&apos;s role, or disabling them,
        signs them out at once. Every action is recorded in the <Link href="/audit?action=admin.*">audit log</Link>.
      </p>

      {problem ? (
        <div className="card" data-testid="users-unavailable">
          <p className="error" role="alert">{problem}</p>
          <p className="note">If the Keycloak admin client was never set up on this server, see <span className="mono">KEYCLOAK_ADMIN_CLIENT_SECRET</span> in infra/.env.example.</p>
        </div>
      ) : (
        <>
          <NewUserForm />

          <form method="get" action="/admin/users" className="inline" role="search" style={{ marginBottom: 12 }}>
            <div><label htmlFor="u-search">Find a person (username, email or name)</label><input id="u-search" name="search" defaultValue={search} data-testid="user-search" /></div>
            <button>Search</button>
            {search && <Link href="/admin/users">Clear</Link>}
          </form>

          {people.length === 0 ? (
            <div className="empty-box"><p className="muted" data-testid="no-users">{search ? 'Nobody matches that search.' : 'There are no users yet.'}</p></div>
          ) : (
            <div className="card">
              <table className="stack" data-testid="users-table">
                <thead><tr><th>Person</th><th>Role</th><th>Status</th><th>Last seen</th><th>Actions</th></tr></thead>
                <tbody>
                  {people.map((p) => (
                    <tr key={p.id} data-testid={`user-${p.username}`}>
                      <td data-label="Person">
                        <strong>{p.username}</strong> {p.you && <span className="role">you</span>}
                        <div className="muted cell-wrap">{p.email ?? 'no email'}</div>
                      </td>
                      <td data-label="Role" data-testid={`role-${p.username}`}>
                        {p.roles.length === 0 ? <span className="muted">none</span> : p.roles.map((r) => ROLE_LABEL[r] ?? r).join(', ')}
                      </td>
                      <td data-label="Status">
                        <span className="state" data-state={p.enabled ? 'up' : 'down'} data-testid={`enabled-${p.username}`}>{p.enabled ? 'Enabled' : 'Disabled'}</span>
                      </td>
                      <td className="muted" data-label="Last seen">{p.lastSeenAt ? <Time iso={p.lastSeenAt} /> : 'never in AegisOps'}</td>
                      <td data-label="Actions" className="actions-cell">
                        <UserActions id={p.id} username={p.username} role={p.roles[0] ?? null} enabled={p.enabled} you={p.you} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="note">
                {page > 1 && <Link href={link(page - 1)}>← Newer page</Link>}
                {page > 1 && people.length === PAGE && ' · '}
                {people.length === PAGE && <Link href={link(page + 1)}>Next page →</Link>}
              </p>
            </div>
          )}
        </>
      )}
    </>
  );
}
