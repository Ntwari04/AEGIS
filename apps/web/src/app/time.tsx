'use client';
import { useEffect, useState } from 'react';

type Opts = { seconds?: boolean; timeOnly?: boolean };

function parts(opts: Opts): Intl.DateTimeFormatOptions {
  return {
    ...(opts.timeOnly ? {} : { day: 'numeric', month: 'short', year: 'numeric' }), // "4 Nov 2026": never read as April
    hour: '2-digit', minute: '2-digit', ...(opts.seconds || opts.timeOnly ? { second: '2-digit' } : {}), hour12: false,
  };
}

/** What the server renders, and what the browser first renders: UTC, labelled, in a fixed locale, so the two always agree. */
export const formatUtc = (d: Date, opts: Opts = {}) => `${new Intl.DateTimeFormat('en-GB', { ...parts(opts), timeZone: 'UTC' }).format(d)} UTC`;

/** The viewer's own timezone, with its name ("GMT+2"), in their own language. */
export const formatLocal = (d: Date, opts: Opts = {}) => new Intl.DateTimeFormat(undefined, { ...parts(opts), timeZoneName: 'short' }).format(d);

/**
 * A time that cannot mislead. The server has no idea where the viewer is, so it says UTC; once the page is in the browser it shows the
 * viewer's own time with the zone named, and the exact UTC instant is in the tooltip.
 */
export function Time({ iso, seconds, timeOnly }: { iso: string; seconds?: boolean; timeOnly?: boolean }) {
  const d = new Date(iso);
  const opts = { seconds, timeOnly };
  const [text, setText] = useState(() => formatUtc(d, opts));
  useEffect(() => setText(formatLocal(new Date(iso), { seconds, timeOnly })), [iso, seconds, timeOnly]);
  return <time dateTime={iso} title={`${d.toISOString()} (UTC)`} suppressHydrationWarning>{text}</time>;
}
