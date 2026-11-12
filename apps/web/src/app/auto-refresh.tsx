'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Keeps a page's data current without reloading it. A meta-refresh throws the whole page away every few seconds: whatever someone
 * was typing is lost and any form they unfolded folds shut again. `router.refresh()` re-reads the server data and updates what changed,
 * and leaves the rest of the page (typed text, open folds, scroll position) exactly as it is.
 *
 * It does nothing while the tab is hidden, and it waits while someone is typing in a field, so a list never shifts under their cursor.
 */
export function AutoRefresh({ everyMs }: { everyMs: number }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.hidden) return;
      const focused = document.activeElement?.tagName;
      if (focused === 'INPUT' || focused === 'TEXTAREA' || focused === 'SELECT') return;
      router.refresh();
    }, everyMs);
    return () => clearInterval(timer);
  }, [everyMs, router]);
  return null;
}
