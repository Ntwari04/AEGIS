import { signIn } from '@/auth';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; ended?: string }> }) {
  const { error, ended } = await searchParams;
  return (
    <div className="center">
      <h1>AegisOps</h1>
      <p>Deploy, monitor and manage your projects in one place.</p>
      <p className="muted">Sign in with your company account.</p>
      {ended && <p className="note" data-testid="session-ended">Your access changed or your session ended, so please sign in again.</p>}
      {error && <p className="error">Sign-in failed. Please try again.</p>}
      <form action={async () => { 'use server'; await signIn('keycloak', { redirectTo: '/projects' }); }}>
        <button data-testid="signin">Sign in</button>
      </form>
    </div>
  );
}
