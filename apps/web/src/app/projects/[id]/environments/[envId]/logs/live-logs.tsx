'use client';
import { useCallback, useEffect, useRef, useState } from 'react';

type Status = 'idle' | 'connecting' | 'live' | 'paused' | 'unavailable';
type Line = { ts: string; line: string; container: string; id: string };

const MAX_LINES = 2000; // the page keeps the newest lines only, so a chatty application cannot exhaust the browser's memory
const LABEL: Record<Status, string> = { idle: 'Not started', connecting: 'Connecting…', live: 'Live', paused: 'Paused', unavailable: 'Unavailable' };

/**
 * Follows the environment's logs as they are written (FR-INFRA-2). Server-sent events: if the connection drops the browser reconnects
 * by itself and the server resumes after the last line it saw; when the server ends a long stream we reconnect from the same point.
 * Log text is shown as TEXT, never as HTML.
 */
export function LiveLogs({ projectId, envId, contains }: { projectId: string; envId: string; contains: string }) {
  const [status, setStatus] = useState<Status>('idle');
  const [lines, setLines] = useState<Line[]>([]);
  const [notice, setNotice] = useState('');
  const [follow, setFollow] = useState(true);
  const source = useRef<EventSource | null>(null);
  const lastId = useRef<string | null>(null);
  const box = useRef<HTMLPreElement>(null);

  const open = useCallback(() => {
    source.current?.close();
    const params = new URLSearchParams();
    if (contains) params.set('q', contains);
    if (lastId.current) params.set('since', lastId.current);
    else params.set('backlog', '120');
    setStatus('connecting');
    const es = new EventSource(`/projects/${encodeURIComponent(projectId)}/environments/${encodeURIComponent(envId)}/logs/stream?${params}`);
    source.current = es;
    es.onopen = () => { setStatus('live'); setNotice(''); };
    es.addEventListener('line', (ev) => {
      const m = ev as MessageEvent<string>;
      const d = JSON.parse(m.data) as Omit<Line, 'id'>;
      lastId.current = m.lastEventId;
      setLines((prev) => {
        const next = [...prev, { ...d, id: m.lastEventId }];
        return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
      });
    });
    es.addEventListener('notice', (ev) => setNotice((JSON.parse((ev as MessageEvent<string>).data) as { message: string }).message));
    es.addEventListener('end', () => {
      es.close();
      setTimeout(() => { if (source.current === es) open(); }, 500); // the server's maximum time: carry on from the last line
    });
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) { setStatus('unavailable'); setNotice('Live logs are not available right now (you may not have access, or too many views are open).'); }
      else setStatus('connecting'); // the browser is already reconnecting
    };
  }, [projectId, envId, contains]);

  const pause = () => { source.current?.close(); source.current = null; setStatus('paused'); };
  useEffect(() => () => source.current?.close(), []);
  useEffect(() => { if (follow && box.current) box.current.scrollTop = box.current.scrollHeight; }, [lines, follow]);

  const running = status === 'live' || status === 'connecting';
  return (
    <div className="card" data-testid="live-card">
      <div className="row">
        <strong>Live view</strong>
        <span className="status" data-testid="live-status" data-status={status === 'live' ? 'SUCCESS' : status === 'unavailable' ? 'FAILED' : 'PENDING'}>{LABEL[status]}</span>
      </div>
      <div className="inline">
        {running
          ? <button type="button" data-testid="live-pause" onClick={pause}>Pause</button>
          : <button type="button" data-testid="live-start" onClick={open}>{lines.length ? 'Resume' : 'Start live view'}</button>}
        <button type="button" className="link" data-testid="live-clear" onClick={() => setLines([])}>Clear</button>
        <label className="check"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} data-testid="live-follow" /> Follow new lines</label>
      </div>
      {notice && <p className="note" data-testid="live-notice">{notice}</p>}
      <pre className="mono live-box" ref={box} data-testid="live-lines" tabIndex={0} aria-live="off">
        {lines.length === 0 ? (running ? 'Waiting for the next log line…' : 'Press “Start live view” to follow this environment’s logs as they are written.') : lines.map((l) => `${l.ts}  ${l.line}`).join('\n')}
      </pre>
      <p className="note">{contains ? `Showing lines containing “${contains}”. ` : ''}Keeps the newest {MAX_LINES.toLocaleString()} lines. A view ends by itself after a while and reconnects from the last line.</p>
    </div>
  );
}
