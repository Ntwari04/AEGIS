import Link from 'next/link';

/**
 * Shown for an address that does not exist, and also for a project or page the person may not see: the two look identical on purpose, so
 * the page cannot be used to find out what exists.
 */
export default function NotFound() {
  return (
    <div className="center" data-testid="not-found">
      <h1>Page not found</h1>
      <p className="muted">It may have been moved or removed, or you may not have access to it.</p>
      <p><Link className="btn" href="/projects">Back to projects</Link></p>
    </div>
  );
}
