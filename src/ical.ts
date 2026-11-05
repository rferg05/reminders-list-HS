// Reads the to-do items out of a Radicale list. A GET on a Radicale
// collection returns the whole list as one iCalendar file: the list's name
// as X-WR-CALNAME, then one VTODO per reminder, as the iPhone Reminders app
// wrote it over CalDAV.
//
// Pure and exported so it can be tested against recorded Radicale output.

export type Priority = 'high' | 'medium' | 'low';

/** A due date as wall-clock time in the household's timezone. */
export interface Due {
  /** `2026-11-05` */
  date: string;
  /** `17:00`, or null for a reminder with a date but no time. */
  time: string | null;
}

export interface Task {
  uid: string;
  title: string;
  notes: string;
  done: boolean;
  /** When it was checked off (UTC ms), or null. */
  completedAt: number | null;
  due: Due | null;
  priority: Priority | null;
  /** The Reminders app's manual order (X-APPLE-SORT-ORDER), or null. */
  sortOrder: number | null;
  /** When it was added (UTC ms); 0 when unknown. */
  createdAt: number;
  /** UID of the reminder this is a subtask of, or null. */
  parent: string | null;
}

export interface TaskList {
  /** The list's name as set on the phone, or '' if Radicale didn't say. */
  name: string;
  tasks: Task[];
}

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

/** Lines are folded at 75 octets: a line starting with a space or tab
 *  continues the one before it. */
export function unfold(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n').filter((l) => l.length > 0);
}

/** `DUE;TZID=America/Chicago:20261105T170000`. Parameter values may be
 *  quoted, and a quoted value may contain `:` or `;`. */
export function parseLine(line: string): Prop | null {
  let i = 0;
  let inQuotes = false;
  const parts: string[] = [];
  let start = 0;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (!inQuotes && c === ';') {
      parts.push(line.slice(start, i));
      start = i + 1;
    } else if (!inQuotes && c === ':') break;
  }
  if (i >= line.length) return null;
  parts.push(line.slice(start, i));
  const [name, ...rawParams] = parts;
  const params: Record<string, string> = {};
  for (const p of rawParams) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: name.toUpperCase(), params, value: line.slice(i + 1) };
}

/** TEXT values escape `\`, `;`, `,` and newlines. */
export function unescapeText(v: string): string {
  return v.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

/** `20261104T150000Z` or `20261104` to UTC ms, or null. */
function utcMs(v: string): number | null {
  const m = /^(\d{4})(\d\d)(\d\d)(?:T(\d\d)(\d\d)(\d\d)?)?Z?$/.exec(v.trim());
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
}

/** The wall-clock date and time an instant shows in `tz`. */
export function wallClock(ms: number, tz: string): { date: string; time: string } {
  const parts: Record<string, string> = {};
  try {
    for (const p of new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(ms)) parts[p.type] = p.value;
  } catch {
    const d = new Date(ms).toISOString();
    return { date: d.slice(0, 10), time: d.slice(11, 16) };
  }
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** The UTC instant of a wall-clock time in `tz`. */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  // Read the guess back in the zone; the difference is the zone's offset.
  // Twice, so a guess on the far side of a DST change settles.
  let t = guess;
  for (let k = 0; k < 2; k++) {
    const w = wallClock(t, tz);
    const [wy, wmo, wd] = w.date.split('-').map(Number);
    const [wh, wmi] = w.time.split(':').map(Number);
    t += guess - Date.UTC(wy, wmo - 1, wd, wh, wmi);
  }
  return t;
}

/** DUE in any of its three forms, as wall-clock time in `tz`:
 *  `VALUE=DATE:20261106` (no time), `20261105T230000Z` (UTC), or
 *  `TZID=America/Chicago:20261105T170000`. A time with neither Z nor TZID
 *  is "floating" and read as household time. */
export function parseDue(prop: Prop, tz: string): Due | null {
  const m = /^(\d{4})(\d\d)(\d\d)(?:T(\d\d)(\d\d)(\d\d)?(Z)?)?$/.exec(prop.value.trim());
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  if (prop.params.VALUE === 'DATE' || m[4] === undefined) return { date, time: null };
  const [y, mo, d, h, mi] = [+m[1], +m[2], +m[3], +m[4], +m[5]];
  let ms: number | null = null;
  if (m[7]) ms = Date.UTC(y, mo - 1, d, h, mi);
  else if (prop.params.TZID && prop.params.TZID !== tz) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: prop.params.TZID });
      ms = zonedToUtc(y, mo, d, h, mi, prop.params.TZID);
    } catch {
      // A TZID only the file's own VTIMEZONE defines: take it as household time.
    }
  }
  if (ms === null) return { date, time: `${m[4]}:${m[5]}` };
  return wallClock(ms, tz);
}

/** iCalendar 1–4 is high, 5 medium, 6–9 low, 0 none. The Reminders app
 *  writes 1, 5 and 9 for !!!, !! and !. */
export function parsePriority(v: string): Priority | null {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n <= 4 ? 'high' : n === 5 ? 'medium' : 'low';
}

function taskFrom(props: Prop[], tz: string): Task | null {
  const get = (name: string) => props.find((p) => p.name === name);
  const uid = get('UID')?.value.trim();
  if (!uid) return null;
  const status = (get('STATUS')?.value ?? '').trim().toUpperCase();
  if (status === 'CANCELLED') return null;
  const completed = get('COMPLETED');
  const done = status === 'COMPLETED' || !!completed;
  const sort = Number(get('X-APPLE-SORT-ORDER')?.value);
  const due = get('DUE');
  // A subtask points at its parent; other RELATED-TO types (siblings,
  // children) say nothing about where this one goes.
  const parent = props.find((p) => p.name === 'RELATED-TO' && (p.params.RELTYPE ?? 'PARENT').toUpperCase() === 'PARENT');
  return {
    uid,
    title: unescapeText(get('SUMMARY')?.value ?? '').trim(),
    notes: unescapeText(get('DESCRIPTION')?.value ?? '').trim(),
    done,
    completedAt: completed ? utcMs(completed.value) : null,
    due: due ? parseDue(due, tz) : null,
    priority: parsePriority(get('PRIORITY')?.value ?? ''),
    sortOrder: Number.isFinite(sort) && get('X-APPLE-SORT-ORDER') ? sort : null,
    createdAt: utcMs(get('CREATED')?.value ?? '') ?? 0,
    parent: parent ? parent.value.trim() : null,
  };
}

/** Every reminder in the file. `tz` is the household's timezone, which due
 *  dates are converted into. */
export function parseTaskList(text: string, tz: string): TaskList {
  let name = '';
  const tasks: Task[] = [];
  const stack: string[] = [];
  let props: Prop[] | null = null;
  for (const line of unfold(text)) {
    const prop = parseLine(line);
    if (!prop) continue;
    if (prop.name === 'BEGIN') {
      const comp = prop.value.trim().toUpperCase();
      stack.push(comp);
      if (comp === 'VTODO' && stack.length === 2) props = [];
      continue;
    }
    if (prop.name === 'END') {
      const comp = stack.pop();
      if (comp === 'VTODO' && props && stack.length === 1) {
        const task = taskFrom(props, tz);
        if (task) tasks.push(task);
        props = null;
      }
      continue;
    }
    // Only the VTODO's own properties: an alarm inside it has its own
    // DESCRIPTION and must not overwrite the reminder's notes.
    if (props && stack.length === 2) props.push(prop);
    else if (stack.length === 1 && prop.name === 'X-WR-CALNAME') name = unescapeText(prop.value).trim();
  }
  return { name, tasks };
}
