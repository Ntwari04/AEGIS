'use client';
import Link from 'next/link';

/**
 * What a person sees when a page fails. It never shows the error's text (that can name internals); it shows a reference
 * (`digest`) that matches the line in the web container's log, so an administrator can find the cause.
 */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="center" data-testid="page-failed">
      <h1>Something went wrong</h1>
      <p className="muted">This page could not be shown. Your work is safe; nothing was changed by the failure itself.</p>
      {error.digest && <p className="note">Reference for your administrator: <span className="mono">{error.digest}</span></p>}
      <p className="inline" style={{ justifyContent: 'center' }}>
        <button type="button" onClick={reset}>Try again</button>
        <Link href="/projects">Back to projects</Link>
      </p>
    </div>
  );
}
