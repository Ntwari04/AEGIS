import { signIn } from '@/auth';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <div className="center">
      <h1>AegisOps</h1>
      <p className="muted">Sign in with your company account.</p>
      {error && <p className="error">Sign-in failed. Please try again.</p>}
      <form action={async () => { 'use server'; await signIn('keycloak', { redirectTo: '/projects' }); }}>
        <button data-testid="signin">Sign in</button>
      </form>
    </div>
  );
}
