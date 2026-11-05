import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { PluginComponentProps } from './hs-plugin';
import { hostFrameStyle } from './host-style';
import { readConfig } from './config';
import type { Config } from './config';
import type { TaskList } from './ical';
import { wallClock } from './ical';
import { chooseLists, discoverLists } from './discover';
import type { ListInfo } from './discover';
import { hostFetcher, ListError, loadList, parseSource, PLUGIN_ID } from './radicale';
import type { Failure, Fetcher, Source } from './radicale';
import { arrange, dueLabel, formatTime, trimOne } from './tasks';
import type { DueTone, Row, TimeFormat } from './tasks';

/** A failed refresh is tried again sooner than a good one is repeated. */
const RETRY_MS = 15_000;
/** The last good copy survives a page reload for this long. */
const CACHE_TTL_MS = 7 * 86_400_000;

// ── List sessions ───────────────────────────────────────────────────────────
// Kept outside React so a module that unmounts when its screen rotates away
// shows its lists at once when it comes back, then catches up.

interface Section {
  info: ListInfo;
  list: TaskList | null;
  failure: Failure | null;
  /** When this list last loaded (UTC ms). */
  okAt: number;
}

interface Session {
  /** Null until the first answer (or a cached copy). */
  sections: Section[] | null;
  /** Finding the account's lists failed. Each list's own failure is on its section. */
  failure: Failure | null;
  loading: Promise<void> | null;
}

const sessions = new Map<string, Session>();
const sourceKey = (s: Source, cfg: Config) =>
  `${cfg.username}@${s.kind === 'account' ? s.url : s.urls.join(' ')}|${cfg.onlyLists.join(',')}`;
const cacheKey = (key: string) => `${PLUGIN_ID}:${key}`;

function sessionFor(key: string): Session {
  let s = sessions.get(key);
  if (!s) {
    const cached = window.__HS_SDK__?.displayCache?.get<Section[]>(cacheKey(key));
    s = { sections: cached?.data ?? null, failure: null, loading: null };
    sessions.set(key, s);
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

const failureOf = (e: unknown): Failure => (e instanceof ListError ? e.failure : { kind: 'unreachable' });

/** One pass: find the lists (for an account), then read each. A list that
 *  fails keeps its last good copy, marked with the failure. */
async function refresh(session: Session, source: Source, cfg: Config, tz: string, fetcher: Fetcher): Promise<void> {
  let infos: ListInfo[];
  if (source.kind === 'account') {
    try {
      infos = chooseLists(await discoverLists(fetcher, source.url, cfg.username, cfg.password), cfg.onlyLists);
    } catch (e) {
      session.failure = failureOf(e);
      return;
    }
  } else {
    infos = source.urls.map((url) => ({ url, name: '', color: null, order: null }));
  }
  session.failure = null;
  const before = new Map((session.sections ?? []).map((s) => [s.info.url, s]));
  session.sections = await Promise.all(infos.map(async (info): Promise<Section> => {
    try {
      const list = await loadList(fetcher, info.url, cfg.username, cfg.password, tz);
      return { info, list, failure: null, okAt: Date.now() };
    } catch (e) {
      const prev = before.get(info.url);
      return { info, list: prev?.list ?? null, failure: failureOf(e), okAt: prev?.okAt ?? 0 };
    }
  }));
}

/** First failure anywhere in the session, for logs and health. */
const firstFailure = (s: Session): Failure | null => s.failure ?? s.sections?.find((x) => x.failure)?.failure ?? null;

/** Loads the lists now, then keeps them fresh. Returns a counter that
 *  changes whenever the session does. */
function useLists(source: Source | null, cfg: Config, tz: string, fetcher: Fetcher): [Session | null, number] {
  const [tick, setTick] = useState(0);
  const key = source ? sourceKey(source, cfg) : null;
  const session = useMemo(() => (key ? sessionFor(key) : null), [key]);
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;

  useEffect(() => {
    if (!session || !source || !key) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refreshMs = cfg.refreshSeconds * 1000;

    const run = async () => {
      if (!session.loading) {
        session.loading = (async () => {
          const had = firstFailure(session);
          try {
            await refresh(session, source, cfgRef.current, tz, fetcher);
          } finally {
            session.loading = null;
          }
          const now = firstFailure(session);
          if (now && now.kind !== had?.kind) {
            log('warn', `Refresh failed: ${now.kind}`);
            health(now, Date.now());
          } else if (!now && had) {
            log('info', 'Radicale is answering again');
            health(null, 0);
          }
          if (session.sections) window.__HS_SDK__?.displayCache?.set(cacheKey(key), session.sections, CACHE_TTL_MS);
        })();
      }
      await session.loading;
      if (!alive) return;
      setTick((t) => t + 1);
      timer = setTimeout(run, firstFailure(session) ? Math.min(RETRY_MS, refreshMs) : refreshMs);
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

/** Changes once the page's fonts have loaded: text measured in a fallback
 *  face is a different width, so the fit has to run again. */
function useFontsReady(): boolean {
  const [ready, setReady] = useState(() => typeof document === 'undefined' || document.fonts?.status !== 'loading');
  useEffect(() => {
    if (ready) return;
    let alive = true;
    void document.fonts.ready.then(() => { if (alive) setReady(true); });
    return () => { alive = false; };
  }, [ready]);
  return ready;
}

function useBoxSize():[React.RefObject<HTMLDivElement | null>, { w: number; h: number }] {
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

function Ring({ done, color }: { done: boolean; color: string }) {
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
        border: `0.12em solid ${color}`,
        background: done ? color : 'rgba(0,0,0,0.15)',
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
  /** The list text's size in px, as shown. */
  fontPx: number;
  /** Heading underline width. */
  rule: string;
}

function TaskRow({ row, ctx, color }: { row: Row; ctx: RowContext; color: string }) {
  const { task, depth } = row;
  const { cfg } = ctx;
  const due = cfg.showDue && task.due && !task.done ? dueLabel(task.due, ctx.today, ctx.nowTime, ctx.timeFormat) : null;
  const notes = cfg.showNotes && !task.done ? task.notes.split('\n')[0] : '';
  return (
    <div
      style={{
        display: 'flex',
        gap: '0.55em',
        padding: '0.32em 0',
        paddingLeft: depth ? '1.55em' : 0,
        fontSize: depth ? '0.9em' : undefined,
        opacity: task.done ? 0.5 : 1,
      }}
    >
      <Ring done={task.done} color={color} />
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
            <span style={{ color, fontWeight: 700, marginRight: '0.3em' }}>{MARKS[task.priority]}</span>
          )}
          {task.title || <span style={{ opacity: 0.6 }}>(no title)</span>}
        </div>
        {(due || notes) && (
          <div style={{ fontSize: '0.78em', lineHeight: 1.3, marginTop: '0.1em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {due && <span style={toneStyle(due.tone, color)}>{due.text}</span>}
            {due && notes && <span style={{ opacity: 0.5 }}> · </span>}
            {notes && <span style={{ opacity: 0.7 }}>{notes}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

/** A list's name and how many are left, underlined in its color. */
function Heading({ name, open, color, size, rule, note, gapBelow = '0.3em' }: { name: string; open: number; color: string; size: string; rule: string; note?: string; gapBelow?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.6em', marginBottom: gapBelow, paddingBottom: '0.3em', borderBottom: `${rule} solid ${color}` }}>
      <div style={{ fontSize: size, fontWeight: 700, flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</div>
      {note && <div style={{ fontSize: '0.7em', opacity: 0.7, whiteSpace: 'nowrap' }}>{note}</div>}
      {open > 0 && <div style={{ fontSize: '0.8em', opacity: 0.75, whiteSpace: 'nowrap' }}>{open} to do</div>}
    </div>
  );
}

// ── Fitting ─────────────────────────────────────────────────────────────────
// Lists flow down the first column, then the next. With Columns on Auto a
// second (and third) column is used only when one won't hold everything,
// and only while each column stays wide enough to read. Whatever still
// doesn't fit is cut from the longest list first, each ending "+3 more", so
// one long list can't push the others off the screen.

interface Group {
  key: string;
  /** Null for a lone list, whose heading sits above the columns. */
  name: string | null;
  open: number;
  color: string;
  rows: Row[];
  /** Shown in place of rows when the list is empty, or failing. */
  message: string;
}

// Text size: with *Scale with module size* on, type grows with the module's
// area against its default size (as in the CTA and Travel modules), then up
// to MAX_GROW times more while every item still fits. The fit starts at the
// largest size and steps down; at each size it tries more columns before
// smaller type. A long list may take type down to MIN_GROW of the scaled
// size, never below the unscaled size, before lists are cut short.

/** The module's default size, which the Style panel's Text size is set for. */
const REFERENCE_AREA = 520 * 640;
/** With room to spare, type grows up to this much past its scaled size. */
const MAX_GROW = 2.2;
/** With too much to show, type shrinks to this much of its scaled size
 *  before the longest list is cut short. */
const MIN_GROW = 0.6;

interface Fit {
  /** Times the scaled size, from MAX_GROW down to the floor. */
  grow: number;
  cols: number;
  shown: number[];
}

function maxAutoCols(width: number, fontPx: number): number {
  return Math.max(1, Math.min(3, Math.floor(width / (fontPx * 13))));
}

/** The text size and layout that fit `target`: the columns, or for a notice
 *  or an empty list the whole box. Measured before paint, so a size that
 *  overflows is never seen. */
function useListFit(
  target: React.RefObject<HTMLDivElement | null>,
  signature: string,
  counts: number[],
  fixedCols: number | null,
  maxGrow: number,
  minGrow: number,
  width: number,
  fontPx: number,
): Fit {
  const start = (): Fit => ({ grow: maxGrow, cols: fixedCols ?? 1, shown: counts });
  const [fit, setFit] = useState<Fit>(start);

  useLayoutEffect(() => setFit(start()), [signature]);

  useLayoutEffect(() => {
    const el = target.current;
    if (!el || fit.shown.length !== counts.length) return;
    const over = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
    if (!over) return;
    if (!fixedCols && fit.cols < maxAutoCols(width, fontPx * fit.grow)) {
      setFit({ ...fit, cols: fit.cols + 1 });
      return;
    }
    if (fit.grow > minGrow) {
      // Area goes with the square of the type size: estimate from how much
      // overflows, but always step down at least 5% so the search ends.
      const ratio = Math.min(el.clientWidth / el.scrollWidth, el.clientHeight / el.scrollHeight);
      const grow = Math.max(minGrow, Math.min(fit.grow * 0.95, fit.grow * Math.sqrt(ratio) * 0.99));
      setFit({ grow, cols: fixedCols ?? 1, shown: counts });
      return;
    }
    const shown = trimOne(fit.shown);
    if (shown) setFit({ ...fit, shown });
  });

  return fit;
}

/** A rule `em` thick, in whole pixels: a fractional one is antialiased toward
 *  gray at some positions, so lists' colors read inconsistently. */
const rulePx = (fontPx: number, em: number, min: number) => `${Math.max(min, Math.round(fontPx * em))}px`;

function GroupColumns({ groups, ctx, fit, colsRef }: { groups: Group[]; ctx: RowContext; fit: Fit; colsRef: React.RefObject<HTMLDivElement | null> }) {
  return (
    <div
      ref={colsRef}
      style={{
        flex: 1,
        minHeight: 0,
        overflow: 'hidden',
        columnCount: fit.cols,
        columnFill: 'auto',
        columnGap: '1.4em',
        columnRule: fit.cols > 1 ? `${rulePx(ctx.fontPx, 0.04, 1)} solid rgba(255,255,255,0.12)` : undefined,
      }}
    >
      {groups.map((g, gi) => {
        const n = fit.shown[gi] ?? g.rows.length;
        const rows = g.rows.slice(0, n);
        const hidden = g.rows.length - rows.length;
        const row = (r: Row) => <TaskRow key={r.task.uid} row={r} ctx={ctx} color={g.color} />;
        return (
          // Margin, not padding: a list that starts a column drops it there,
          // so its heading lines up with the other columns' tops.
          <div key={g.key} style={{ marginTop: gi > 0 && g.name !== null ? '0.7em' : 0 }}>
            {/* A heading never ends a column on its own: it moves with its first row. */}
            <div style={{ breakInside: 'avoid' }}>
              {g.name !== null && <Heading name={g.name} open={g.open} color={g.color} size="1em" rule={ctx.rule} />}
              {rows.length > 0 ? row(rows[0]) : g.message && (
                <div style={{ padding: '0.2em 0 0.2em 1.55em', fontSize: '0.85em', opacity: 0.65 }}>{g.message}</div>
              )}
            </div>
            {rows.slice(1).map((r) => <div key={r.task.uid} style={{ breakInside: 'avoid' }}>{row(r)}</div>)}
            {hidden > 0 && (
              <div style={{ breakInside: 'avoid', padding: '0.3em 0 0 1.55em', fontSize: '0.85em', opacity: 0.7 }}>
                +{hidden} more
              </div>
            )}
          </div>
        );
      })}
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

const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };

function failureNotice(f: Failure, url: string): { title: string; detail?: string } {
  switch (f.kind) {
    case 'unreachable':
      return { title: `Can't reach Radicale at ${hostOf(url)}`, detail: 'Check that it is running on the Pi: sudo systemctl status radicale' };
    case 'cantList':
      return { title: `Can't ask ${hostOf(url)} for its lists`, detail: 'The radicale-lists helper on the Pi finds them. Re-run install-radicale.sh (it keeps passwords and lists) to add it, or check it: sudo systemctl status radicale-lists' };
    case 'proxy':
      return { title: 'Home Screens blocked the request to Radicale', detail: f.message };
    case 'login':
      return { title: 'Radicale turned down the user name or password', detail: "Check them in this module's settings. The installer printed the display account's password." };
    case 'forbidden':
      return { title: "This account can't read that", detail: 'The display account can read the family account and its lists only.' };
    case 'notFound':
      return { title: 'Nothing at that address', detail: "Use the family account's address, like http://192.168.1.14:5232/family/, to show every list." };
    case 'notAList':
      return { title: "That address isn't a reminders list", detail: "Use the family account's address, like http://192.168.1.14:5232/family/, to show every list." };
    default:
      return { title: `Radicale answered with an error (${f.status})` };
  }
}

/** One line for a list that can't be read, under its heading. */
const shortFailure = (f: Failure) =>
  f.kind === 'login' ? 'Wrong user name or password'
    : f.kind === 'forbidden' ? "The display account can't read this list"
      : f.kind === 'notFound' ? 'No list at this address'
        : f.kind === 'notAList' ? "This isn't a reminders list"
          : f.kind === 'proxy' ? `Blocked by Home Screens: ${f.message}`
            : "Can't reach Radicale";

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
  const parsed = useMemo(() => parseSource(cfg.listUrl), [cfg.listUrl]);
  const source = typeof parsed === 'string' ? null : parsed;
  const tz = props.timezone || defaultTz();
  const fetcher = useMemo(() => props.fetcher ?? hostFetcher(), [props.fetcher]);
  const [session] = useLists(source, cfg, tz, fetcher);
  const clock = useNow();
  const now = props.now ?? clock;
  const [boxRef, box] = useBoxSize();

  const timeFormat: TimeFormat = cfg.timeFormat === 'auto' ? props.timeFormat ?? '12h' : cfg.timeFormat;
  const wall = wallClock(now, tz);
  const sections = session?.sections ?? null;
  const lone = sections?.length === 1 && !(source?.kind === 'account' && cfg.title);

  const groups = useMemo((): Group[] => {
    if (!sections) return [];
    const all = sections.map((s, i): Group => {
      const rows = s.list ? arrange(s.list.tasks, cfg.sortBy, cfg.keepDoneHours * 3_600_000, now) : [];
      return {
        key: `${i}:${s.info.url}`,
        name: lone ? null : s.info.name || s.list?.name || 'To-do',
        open: s.list ? s.list.tasks.filter((t) => !t.done).length : 0,
        color: (cfg.listColors && s.info.color) || cfg.accentColor,
        rows,
        message: !s.list && s.failure ? shortFailure(s.failure) : rows.length === 0 ? cfg.emptyText : '',
      };
    });
    return cfg.hideEmpty && !lone ? all.filter((g) => g.rows.length > 0 || (g.message && g.message !== cfg.emptyText)) : all;
  }, [sections, lone, cfg, now]);

  const fontPx = (Number(style.fontSize) || 22) * cfg.textScale;
  const url = source ? (source.kind === 'account' ? source.url : source.urls[0]) : '';

  let notice: { title: string; detail?: string } | null = null;
  if (parsed === 'empty') notice = { title: 'Add your reminders', detail: "Put the family account's address, like http://192.168.1.14:5232/family/, in this module's settings." };
  else if (parsed === 'notALink') notice = { title: "That isn't a Radicale address", detail: 'It should look like http://192.168.1.14:5232/family/' };
  else if (parsed === 'loopback') notice = { title: "Use the Pi's network address, not localhost", detail: 'Home Screens only lets plugins reach Radicale by its LAN address, like http://192.168.1.14:5232/family/' };
  else if (session && !sections) notice = session.failure ? failureNotice(session.failure, url) : { title: 'Loading lists…' };
  else if (sections && sections.length === 0) {
    notice = cfg.onlyLists.length
      ? { title: 'None of those lists were found', detail: `Looking for: ${cfg.onlyLists.join(', ')}. Names must match the phones (any capitalization).` }
      : { title: 'No reminders lists yet', detail: 'Make one in the Reminders app under Home, and it shows up here.' };
  } else if (lone && sections && !sections[0].list && sections[0].failure) notice = failureNotice(sections[0].failure, sections[0].info.url);

  // Not updated: the oldest good copy among the lists still showing one.
  const failing = session && (session.failure || sections?.some((s) => s.failure && s.list));
  const staleSince = failing && sections ? Math.min(...sections.filter((s) => s.list).map((s) => s.okAt)) : 0;
  const staleNote = staleSince > 0 ? `Not updated since ${formatTime(wallClock(staleSince, tz).time, timeFormat)}` : undefined;

  const loneSection = lone && sections ? sections[0] : null;
  const allEmpty = groups.length === 0 || groups.every((g) => g.rows.length === 0 && !g.message);
  const topTitle = loneSection
    ? cfg.title || loneSection.info.name || loneSection.list?.name || 'To-do'
    : cfg.title;
  const showColumns = !notice && !(loneSection ? groups[0]?.rows.length === 0 : allEmpty) && box.w > 0;

  const sizeScale = cfg.scaleWithSize && box.w > 0 && box.h > 0
    ? Math.min(3, Math.max(0.75, Math.sqrt((box.w * box.h) / REFERENCE_AREA)))
    : 1;
  const fontsReady = useFontsReady();
  const colsRef = useRef<HTMLDivElement>(null);
  const fit = useListFit(
    showColumns ? colsRef : boxRef,
    [
      groups.map((g) => `${g.key}:${g.name}:${g.message}:${g.rows.map((r) => `${r.task.uid}/${r.task.done}/${r.task.title.length}`).join(',')}`).join('|'),
      `${box.w}x${box.h}`, fontPx, sizeScale, cfg.columns, cfg.showDue, cfg.showNotes, cfg.showHeader,
      topTitle, staleNote, notice?.title, notice?.detail, fontsReady,
    ].join('#'),
    groups.map((g) => g.rows.length),
    cfg.columns === 'auto' ? null : Number(cfg.columns),
    cfg.scaleWithSize ? MAX_GROW : 1,
    // Never smaller than the Style panel's Text size alone would make it.
    cfg.scaleWithSize ? Math.min(1, Math.max(MIN_GROW, 1 / sizeScale)) : 1,
    box.w,
    fontPx * sizeScale,
  );
  const shownPx = fontPx * sizeScale * fit.grow;
  const ctx: RowContext = { cfg, today: wall.date, nowTime: wall.time, timeFormat, fontPx: shownPx, rule: rulePx(shownPx, 0.08, 2) };

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
          fontSize: `${cfg.textScale * sizeScale * fit.grow}em`,
          textShadow: TEXT_SHADOW,
        }}
      >
        {notice && <Notice {...notice} />}
        {!notice && cfg.showHeader && topTitle && (
          <Heading
            name={topTitle}
            open={loneSection?.list ? loneSection.list.tasks.filter((t) => !t.done).length : 0}
            color={loneSection ? groups[0]?.color ?? cfg.accentColor : cfg.accentColor}
            size="1.15em"
            rule={ctx.rule}
            note={staleNote}
            gapBelow={loneSection ? '0.3em' : '0.6em'}
          />
        )}
        {!notice && (loneSection ? groups[0]?.rows.length === 0 : allEmpty) && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.7 }}>{cfg.emptyText}</div>
        )}
        {showColumns && <GroupColumns groups={groups} ctx={ctx} fit={fit} colsRef={colsRef} />}
        {!notice && staleNote && !(cfg.showHeader && topTitle) && (
          <div style={{ position: 'absolute', right: 0, bottom: 0, fontSize: '0.7em', opacity: 0.7 }}>{staleNote}</div>
        )}
      </div>
    </div>
  );
}
