// Which reminders show, in what order, and how their due dates read.
// Pure, so it can be tested without a host.

import type { Due, Task } from './ical';

export type SortBy = 'phone' | 'due';
export type TimeFormat = '12h' | '24h';

export interface Row {
  task: Task;
  /** 1 for a subtask shown under its parent. */
  depth: number;
}

const byPhoneOrder = (a: Task, b: Task) =>
  (a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity) ||
  a.createdAt - b.createdAt ||
  a.title.localeCompare(b.title);

const dueKey = (d: Due | null) => (d ? `${d.date}T${d.time ?? '99:99'}` : '~');

const byDue = (a: Task, b: Task) => (dueKey(a.due) < dueKey(b.due) ? -1 : dueKey(a.due) > dueKey(b.due) ? 1 : byPhoneOrder(a, b));

/** The rows to draw: open reminders in order, each followed by its open
 *  subtasks, then reminders checked off within the last `keepDoneMs`, most
 *  recent first. A subtask whose parent isn't showing stands on its own. */
export function arrange(tasks: Task[], sortBy: SortBy, keepDoneMs: number, now: number): Row[] {
  const order = sortBy === 'due' ? byDue : byPhoneOrder;
  const open = tasks.filter((t) => !t.done);
  const openIds = new Set(open.map((t) => t.uid));
  const children = new Map<string, Task[]>();
  const top: Task[] = [];
  for (const t of open) {
    if (t.parent && t.parent !== t.uid && openIds.has(t.parent)) {
      const list = children.get(t.parent) ?? [];
      list.push(t);
      children.set(t.parent, list);
    } else top.push(t);
  }
  const rows: Row[] = [];
  for (const t of top.sort(order)) {
    rows.push({ task: t, depth: 0 });
    for (const c of (children.get(t.uid) ?? []).sort(order)) rows.push({ task: c, depth: 1 });
  }
  if (keepDoneMs > 0) {
    const recent = tasks
      .filter((t) => t.done && t.completedAt !== null && now - t.completedAt <= keepDoneMs)
      .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
    for (const t of recent) rows.push({ task: t, depth: 0 });
  }
  return rows;
}

// ── Due dates ───────────────────────────────────────────────────────────────

export type DueTone = 'overdue' | 'today' | 'soon' | 'later';

export interface DueLabel {
  text: string;
  tone: DueTone;
}

/** `2026-11-05` plus `n` days. */
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  const ms = (s: string) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ms(to) - ms(from)) / 86_400_000);
}

/** `5p`, `5:30p` or `17:00`, `17:30`, like the wall calendar. */
export function formatTime(hhmm: string, format: TimeFormat): string {
  const [h, m] = hhmm.split(':').map(Number);
  if (format === '24h') return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}${m ? `:${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'a' : 'p'}`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dayName(date: string, today: string): string {
  const diff = daysBetween(today, date);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  const [y, m, d] = date.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (diff > 1 && diff < 7) return WEEKDAYS[wd];
  if (diff < -1 && diff > -7) return `Last ${WEEKDAYS[wd]}`;
  return `${MONTHS[m - 1]} ${d}`;
}

/** `Today 5p`, `Tomorrow`, `Fri`, `Nov 20`; overdue when the day, or the
 *  time today, has passed. `today` and `nowTime` are household wall clock. */
export function dueLabel(due: Due, today: string, nowTime: string, format: TimeFormat): DueLabel {
  const diff = daysBetween(today, due.date);
  const overdue = diff < 0 || (diff === 0 && due.time !== null && due.time < nowTime);
  const name = dayName(due.date, today);
  const text = due.time ? `${name} ${formatTime(due.time, format)}` : name;
  const tone: DueTone = overdue ? 'overdue' : diff === 0 ? 'today' : diff < 7 ? 'soon' : 'later';
  return { text, tone };
}
