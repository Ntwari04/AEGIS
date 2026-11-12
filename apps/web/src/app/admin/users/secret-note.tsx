/** A temporary password, shown once. Plain text in the page only: it is not stored anywhere the dashboard can show it again. */
export function SecretNote({ username, password }: { username: string; password: string }) {
  return (
    <div className="card" data-testid="temp-password-card" role="status">
      <strong>Temporary password for {username}. Copy it now: it is shown once and cannot be recovered.</strong>
      <p><code className="mono" data-testid="temp-password">{password}</code></p>
      <p className="note">
        Give it to them over a channel you trust (not email in plain text). At first sign-in they must choose their own password and,
        for platform admins and DevOps engineers, enrol an authenticator app.
      </p>
    </div>
  );
}
