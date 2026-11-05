import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { PluginComponentProps } from './hs-plugin';
import { hostFrameStyle } from './host-style';
import { readConfig } from './config';
import type { Config } from './config';
import type { Task, TaskList } from './ical';
import { wallClock } from './ical';
import { hostFetcher, ListError, loadList, parseListUrl, PLUGIN_ID } from './radicale';
import type { Failure, Fetcher } from './radicale';
import { arrange, dueLabel, formatTime } from './tasks';
import type { DueTone, Row, TimeFormat } from './tasks';

/** A failed refresh is tried again sooner than a good one is repeated. */
const RETRY_MS = 15_000;
/** The last good copy survives a page reload for this long. */
const CACHE_TTL_MS = 7 * 86_400_000;

// ── List sessions ───────────────────────────────────────────────────────────
// Kept outside React so a module that unmounts when its screen rotates away
// shows the list at once when it comes back, without asking Radicale again.

interface Session {
  list: TaskList | null;
  failure: Failure | null;
  /** When the list last loaded successfully (UTC ms). */
  okAt: number;
  loading: Promise<void> | null;
}

const sessions = new Map<string, Session>();
const cacheKey = (url: string) => `${PLUGIN_ID}:${url}`;

function sessionFor(url: string, user: string): Session {
  const id = `${user}@${url}`;
  let s = sessions.get(id);
  if (!s) {
    const cached = window.__HS_SDK__?.displayCache?.get<{ list: TaskList; okAt: number }>(cacheKey(url));
    s = { list: cached?.data.list ?? null, failure: null, okAt: cached?.data.okAt ?? 0, loading: null };
    sessions.set(id, s);
  }
  return s;
}

function log(level: 'info' | 'warn' | 'error', message: string) {
  try {
    window.__HS_SDK__?.emit?.({ type: 'log', level, message: `[${PLUGIN_ID}] ${message}` });
  } catch { /* logging is best effort */ }
}

function health(failure: Failure | null, since: number) {
  try {
    window.__HS_SDK__?.reportProviderHealth?.(PLUGIN_ID, failure ? { ok: false, message: failure.kind, since } : { ok: true });
  } catch { /* best effort */ }
}

/** Loads the list now if it's due, then keeps it fresh. Returns a counter
 *  that changes whenever the session does. */
function useList(url: string | null, cfg: Config, tz: string, fetcher: Fetcher): [Session | null, number] {
  const [tick, setTick] = useState(0);
  const session = useMemo(() => (url ? sessionFor(url, cfg.username) : null), [url, cfg.username]);

  useEffect(() => {
    if (!session || !url) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refreshMs = cfg.refreshSeconds * 1000;

    const run = async () => {
      if (!session.loading) {
        session.loading = (async () => {
          try {
            session.list = await loadList(fetcher, url, cfg.username, cfg.password, tz);
            session.okAt = Date.now();
            if (session.failure) {
              log('info', 'Radicale is answering again');
              health(null, 0);
            }
            session.failure = null;
            window.__HS_SDK__?.displayCache?.set(cacheKey(url), { list: session.list, okAt: session.okAt }, CACHE_TTL_MS);
          } catch (e) {
            const failure: Failure = e instanceof ListError ? e.failure : { kind: 'unreachable' };
            if (session.failure?.kind !== failure.kind) {
              log('warn', `List refresh failed: ${failure.kind}`);
              health(failure, Date.now());
            }
            session.failure = failure;
          } finally {
            session.loading = null;
          }
        })();
      }
      await session.loading;
      if (!alive) return;
      setTick((t) => t + 1);
      timer = setTimeout(run, session.failure ? Math.min(RETRY_MS, refreshMs) : refreshMs);
    };

    // Radicale answers in milliseconds, so ask on every mount: a screen
    // rotating back in shows the kept copy at once and catches up.
    void run();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [session, fetcher, cfg.password, cfg.refreshSeconds, tz]);

  return [session, tick];
}

/** Household wall clock, updated each minute, so "Today 5p" turns overdue
 *  at 5:00 and checked-off items age out without waiting for a refresh. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function useBoxSize(): [React.RefObject<HTMLDivElement | null>, { w: number; h: number }] {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      // Layout size, not on-screen size: the editor scales the canvas down
      // with a transform.
      const w = el.clientWidth;
      const h = el.clientHeight;
      setSize((s) => (s.w === w && s.h === h ? s : { w, h }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

// ── Rows ────────────────────────────────────────────────────────────────────

const TEXT_SHADOW = '0 1px 2px rgba(0,0,0,0.55)';

function toneStyle(tone: DueTone, accent: string): CSSProperties {
  switch (tone) {
    case 'overdue': return { color: '#f87171', fontWeight: 600 };
    case 'today': return { color: accent, fontWeight: 600 };
    case 'soon': return { opacity: 0.85 };
    default: return { opacity: 0.65 };
  }
}

function Ring({ done, accent }: { done: boolean; accent: string }) {
  return (
    <span
      aria-hidden
      style={{
        flex: '0 0 auto',
        width: '1em',
        height: '1em',
        marginTop: '0.18em',
        borderRadius: '50%',
        boxSizing: 'border-box',
        border: `0.12em solid ${accent}`,
        background: done ? accent : 'rgba(0,0,0,0.15)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {done && (
        <svg viewBox="0 0 12 12" width="0.62em" height="0.62em">
          <path d="M2 6.4 4.8 9 10 3.4" fill="none" stroke="#000" strokeOpacity="0.75" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </span>
  );
}

const MARKS = { high: '!!!', medium: '!!', low: '!' } as const;

interface RowContext {
  cfg: Config;
  today: string;
  nowTime: string;
  timeFormat: TimeFormat;
}

function TaskRow({ row, ctx }: { row: Row; ctx: RowContext }) {
  const { task, depth } = row;
  const { cfg } = ctx;
  const due = cfg.showDue && task.due && !task.done ? dueLabel(task.due, ctx.today, ctx.nowTime, ctx.timeFormat) : null;
  const notes = cfg.showNotes && !task.done ? task.notes.split('\n')[0] : '';
  return (
    <div
      style={{
        breakInside: 'avoid',
        display: 'flex',
        gap: '0.55em',
        padding: '0.32em 0',
        paddingLeft: depth ? '1.55em' : 0,
        fontSize: depth ? '0.9em' : undefined,
        opacity: task.done ? 0.5 : 1,
      }}
    >
      <Ring done={task.done} accent={cfg.accentColor} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <div
          style={{
            lineHeight: 1.3,
            overflowWrap: 'anywhere',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            textDecoration: task.done ? 'line-through' : undefined,
          }}
        >
          {cfg.showPriority && task.priority && !task.done && (
            <span style={{ color: cfg.accentColor, fontWeight: 700, marginRight: '0.3em' }}>{MARKS[task.priority]}</span>
          )}
          {task.title || <span style={{ opacity: 0.6 }}>(no title)</span>}
        </div>
        {(due || notes) && (
          <div style={{ fontSize: '0.78em', lineHeight: 1.3, marginTop: '0.1em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {due && <span style={toneStyle(due.tone, cfg.accentColor)}>{due.text}</span>}
            {due && notes && <span style={{ opacity: 0.5 }}> · </span>}
            {notes && <span style={{ opacity: 0.7 }}>{notes}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Fitting ─────────────────────────────────────────────────────────────────
// Rows fill the first column top to bottom, then the next. With Columns on
// Auto a second (and third) column is used only when one won't hold them
// all, and only while each column stays wide enough to read. Whatever still
// doesn't fit is left off with "+3 more".

interface Fit {
  cols: number;
  shown: number;
}

function maxAutoCols(width: number, fontPx: number): number {
  return Math.max(1, Math.min(3, Math.floor(width / (fontPx * 13))));
}

function TaskColumns({ rows, ctx, fontPx, box }: { rows: Row[]; ctx: RowContext; fontPx: number; box: { w: number; h: number } }) {
  const ref = useRef<HTMLDivElement>(null);
  const fixed = ctx.cfg.columns === 'auto' ? null : Number(ctx.cfg.columns);
  const start = (): Fit => ({ cols: fixed ?? 1, shown: rows.length });
  const [fit, setFit] = useState<Fit>(start);
  const signature = `${rows.map((r) => `${r.task.uid}:${r.task.done}:${r.task.title.length}`).join(',')}|${box.w}x${box.h}|${fontPx}|${ctx.cfg.columns}|${ctx.cfg.showDue}|${ctx.cfg.showNotes}`;

  useLayoutEffect(() => setFit(start()), [signature]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const over = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
    if (!over) return;
    if (!fixed && fit.cols < maxAutoCols(box.w, fontPx)) setFit({ ...fit, cols: fit.cols + 1 });
    else if (fit.shown > 0) setFit({ ...fit, shown: fit.shown - 1 });
  });

  const hidden = rows.length - fit.shown;
  return (
    <div
      ref={ref}
      style={{
        flex: 1,
        minHeight: 0,
        overflow: 'hidden',
        columnCount: fit.cols,
        columnFill: 'auto',
        columnGap: '1.4em',
        columnRule: fit.cols > 1 ? '1px solid rgba(255,255,255,0.12)' : undefined,
      }}
    >
      {rows.slice(0, fit.shown).map((r) => <TaskRow key={r.task.uid} row={r} ctx={ctx} />)}
      {hidden > 0 && (
        <div style={{ breakInside: 'avoid', padding: '0.3em 0 0 1.55em', fontSize: '0.85em', opacity: 0.7 }}>
          +{hidden} more
        </div>
      )}
    </div>
  );
}

// ── Notices ─────────────────────────────────────────────────────────────────

function Notice({ title, detail }: { title: string; detail?: string }) {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        padding: '1em',
        gap: '0.4em',
      }}
    >
      <div style={{ fontSize: '1.05em', fontWeight: 600 }}>{title}</div>
      {detail && <div style={{ fontSize: '0.8em', opacity: 0.75, maxWidth: '32em' }}>{detail}</div>}
    </div>
  );
}

function failureNotice(f: Failure, url: string): { title: string; detail?: string } {
  const origin = (() => { try { return new URL(url).host; } catch { return url; } })();
  switch (f.kind) {
    case 'unreachable':
      return { title: `Can't reach Radicale at ${origin}`, detail: 'Check that it is running on the Pi: sudo systemctl status radicale' };
    case 'proxy':
      return { title: 'Home Screens blocked the request to Radicale', detail: f.message };
    case 'login':
      return { title: 'Radicale turned down the user name or password', detail: "Check them in this module's settings. The installer printed the display account's password." };
    case 'forbidden':
      return { title: "This account can't read that list", detail: 'The display account can read lists in the family account only.' };
    case 'notFound':
      return { title: 'No list at that address', detail: "Copy the list's address from Radicale's web page, http://<pi>:5232/.web" };
    case 'notAList':
      return { title: "That address isn't a reminders list", detail: 'It should end in the list\'s folder, like /family/household/' };
    default:
      return { title: `Radicale answered with an error (${f.status})` };
  }
}

// ── Module ──────────────────────────────────────────────────────────────────

const defaultTz = () => {
  try {
    return window.__HS_SDK__?.getHostSettings?.().timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
};

export default function RemindersList(props: PluginComponentProps & { fetcher?: Fetcher; now?: number }) {
  const { style } = props;
  const cfg = useMemo(() => readConfig(props.config ?? {}), [props.config]);
  const parsed = useMemo(() => parseListUrl(cfg.listUrl), [cfg.listUrl]);
  const url = parsed === 'empty' || parsed === 'notALink' || parsed === 'loopback' ? null : parsed;
  const tz = props.timezone || defaultTz();
  const fetcher = useMemo(() => props.fetcher ?? hostFetcher(), [props.fetcher]);
  const [session] = useList(url, cfg, tz, fetcher);
  const clock = useNow();
  const now = props.now ?? clock;
  const [boxRef, box] = useBoxSize();

  const timeFormat: TimeFormat = cfg.timeFormat === 'auto' ? props.timeFormat ?? '12h' : cfg.timeFormat;
  const wall = wallClock(now, tz);
  const list = session?.list ?? null;
  const rows = useMemo(
    () => (list ? arrange(list.tasks, cfg.sortBy, cfg.keepDoneHours * 3_600_000, now) : []),
    [list, cfg.sortBy, cfg.keepDoneHours, now],
  );
  const openCount = list ? list.tasks.filter((t: Task) => !t.done).length : 0;
  const fontPx = (Number(style.fontSize) || 22) * cfg.textScale;

  let notice: { title: string; detail?: string } | null = null;
  if (parsed === 'empty') notice = { title: 'Add a reminders list', detail: "Paste the list's Radicale address into this module's settings." };
  else if (parsed === 'notALink') notice = { title: "That isn't a list address", detail: 'It should look like http://192.168.1.14:5232/family/household/' };
  else if (parsed === 'loopback') notice = { title: "Use the Pi's network address, not localhost", detail: 'Home Screens only lets plugins reach Radicale by its LAN address, like http://192.168.1.14:5232/family/household/' };
  else if (session && url && !list) notice = session.failure ? failureNotice(session.failure, url) : { title: 'Loading list…' };

  const title = cfg.title || list?.name || 'To-do';
  const stale = !!(list && session?.failure);

  return (
    <div style={{ ...hostFrameStyle(style, { baseFontSize: 22 }) }}>
      <div
        ref={boxRef}
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          fontSize: `${cfg.textScale}em`,
          textShadow: TEXT_SHADOW,
        }}
      >
        {notice && <Notice {...notice} />}
        {!notice && list && cfg.showHeader && (
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.6em', marginBottom: '0.3em', paddingBottom: '0.3em', borderBottom: `0.08em solid ${cfg.accentColor}` }}>
            <div style={{ fontSize: '1.15em', fontWeight: 700, flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</div>
            {stale && session && (
              <div style={{ fontSize: '0.7em', opacity: 0.7, whiteSpace: 'nowrap' }} title={session.failure?.kind}>
                Not updated since {formatTime(wallClock(session.okAt, tz).time, timeFormat)}
              </div>
            )}
            {openCount > 0 && <div style={{ fontSize: '0.8em', opacity: 0.75, whiteSpace: 'nowrap' }}>{openCount} to do</div>}
          </div>
        )}
        {!notice && list && rows.length === 0 && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.7 }}>{cfg.emptyText}</div>
        )}
        {!notice && list && rows.length > 0 && box.w > 0 && (
          <TaskColumns rows={rows} ctx={{ cfg, today: wall.date, nowTime: wall.time, timeFormat }} fontPx={fontPx} box={box} />
        )}
      </div>
    </div>
  );
}
