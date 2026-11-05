import { describe, expect, it } from 'vitest';
import household from './fixtures/radicale-household.ics?raw';
import propfind from './fixtures/radicale-propfind-family.xml?raw';
import { chooseLists, discoverLists, helperUrl, normalizeColor, parseLists } from './discover';
import type { Fetcher } from './radicale';
import { parseDue, parseLine, parseTaskList, unescapeText, unfold } from './ical';
import type { Task } from './ical';
import { basicAuth, ListError, parseListUrl, parseSource } from './radicale';
import { arrange, dueLabel, formatTime, trimOne } from './tasks';

const TZ = 'America/Chicago';

// Recorded from Radicale 3.9: a GET on a list holding what the Reminders app
// writes (folded long title, timed and dated due, priority, a subtask, an
// alarm, a checked-off and a deleted-in-place item).
describe('a Radicale list', () => {
  const list = parseTaskList(household, TZ);
  const byUid = Object.fromEntries(list.tasks.map((t) => [t.uid, t])) as Record<string, Task>;

  it('takes the name from the phone', () => {
    expect(list.name).toBe('Household');
  });

  it('skips cancelled items', () => {
    expect(Object.keys(byUid).sort()).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
  });

  it('unfolds and unescapes titles and notes', () => {
    expect(byUid.a1.title).toBe('Milk, eggs and a very long item name that needs folding across the 75 octet line limit here');
    expect(byUid.a2.notes).toBe('Online\nacct in 1Password');
  });

  it("keeps an alarm's DESCRIPTION out of the notes", () => {
    expect(byUid.a5.notes).toBe('');
    expect(byUid.a5.title).toBe('Call plumber');
  });

  it('reads due dates into household time', () => {
    expect(byUid.a2.due).toEqual({ date: '2026-11-05', time: '17:00' }); // TZID=America/Chicago
    expect(byUid.a5.due).toEqual({ date: '2026-11-04', time: '09:00' }); // 15:00Z in CST
    expect(byUid.a3.due).toEqual({ date: '2026-11-06', time: null }); // VALUE=DATE
  });

  it('reads priority, order, completion and parents', () => {
    expect(byUid.a2.priority).toBe('high');
    expect(byUid.a5.priority).toBe('low');
    expect(byUid.a1.priority).toBeNull();
    expect(byUid.a1.sortOrder).toBe(100);
    expect(byUid.a2.sortOrder).toBeNull();
    expect(byUid.a3.done).toBe(true);
    expect(byUid.a3.completedAt).toBe(Date.UTC(2026, 10, 4, 15));
    expect(byUid.a4.parent).toBe('a1');
  });
});

describe('iCalendar details', () => {
  it('unfolds lines continued with a space or tab', () => {
    expect(unfold('SUMMARY:ab\r\n c\r\n\tde\r\nUID:1\r\n')).toEqual(['SUMMARY:abcde', 'UID:1']);
  });

  it('allows quoted parameters with colons', () => {
    expect(parseLine('RELATED-TO;X-NOTE="a:b;c":parent-1')).toEqual({
      name: 'RELATED-TO', params: { 'X-NOTE': 'a:b;c' }, value: 'parent-1',
    });
  });

  it('unescapes text', () => {
    expect(unescapeText('a\\, b\\; c\\\\d\\Ne')).toBe('a, b; c\\d\ne');
  });

  it('converts a due time from another zone', () => {
    const due = parseDue({ name: 'DUE', params: { TZID: 'America/New_York' }, value: '20261105T170000' }, TZ);
    expect(due).toEqual({ date: '2026-11-05', time: '16:00' });
  });

  it('reads a floating or unknown-zone time as household time', () => {
    expect(parseDue({ name: 'DUE', params: {}, value: '20261105T081500' }, TZ)).toEqual({ date: '2026-11-05', time: '08:15' });
    expect(parseDue({ name: 'DUE', params: { TZID: 'Custom/Zone' }, value: '20261105T081500' }, TZ)).toEqual({ date: '2026-11-05', time: '08:15' });
  });
});

const task = (uid: string, over: Partial<Task> = {}): Task => ({
  uid, title: uid, notes: '', done: false, completedAt: null, due: null, priority: null, sortOrder: null, createdAt: 0, parent: null, ...over,
});

describe('arranging', () => {
  const now = Date.UTC(2026, 10, 4, 18);

  it('follows phone order, then when added', () => {
    const rows = arrange([task('c', { createdAt: 3 }), task('b', { sortOrder: 2 }), task('a', { sortOrder: 1 }), task('d', { createdAt: 1 })], 'phone', 0, now);
    expect(rows.map((r) => r.task.uid)).toEqual(['a', 'b', 'd', 'c']);
  });

  it('can put the soonest due first, undated last', () => {
    const rows = arrange([
      task('none', { sortOrder: 1 }),
      task('fri', { due: { date: '2026-11-06', time: null } }),
      task('today9', { due: { date: '2026-11-04', time: '09:00' } }),
      task('today', { due: { date: '2026-11-04', time: null } }),
    ], 'due', 0, now);
    expect(rows.map((r) => r.task.uid)).toEqual(['today9', 'today', 'fri', 'none']);
  });

  it('puts open subtasks under their parent', () => {
    const rows = arrange([task('p', { sortOrder: 2 }), task('q', { sortOrder: 1 }), task('kid', { parent: 'p' }), task('orphan', { parent: 'gone', sortOrder: 3 })], 'phone', 0, now);
    expect(rows.map((r) => `${r.task.uid}:${r.depth}`)).toEqual(['q:0', 'p:0', 'kid:1', 'orphan:0']);
  });

  it('keeps recently checked-off items at the bottom, newest first', () => {
    const tasks = [
      task('open'),
      task('old', { done: true, completedAt: now - 5 * 3_600_000 }),
      task('recent', { done: true, completedAt: now - 3_600_000 }),
      task('newest', { done: true, completedAt: now - 60_000 }),
      task('undated', { done: true }),
    ];
    expect(arrange(tasks, 'phone', 0, now).map((r) => r.task.uid)).toEqual(['open']);
    expect(arrange(tasks, 'phone', 2 * 3_600_000, now).map((r) => r.task.uid)).toEqual(['open', 'newest', 'recent']);
  });
});

describe('due labels', () => {
  const today = '2026-11-04'; // a Wednesday

  it('names nearby days', () => {
    expect(dueLabel({ date: '2026-11-04', time: null }, today, '12:00', '12h')).toEqual({ text: 'Today', tone: 'today' });
    expect(dueLabel({ date: '2026-11-05', time: '17:30' }, today, '12:00', '12h')).toEqual({ text: 'Tomorrow 5:30p', tone: 'soon' });
    expect(dueLabel({ date: '2026-11-06', time: null }, today, '12:00', '12h').text).toBe('Fri');
    expect(dueLabel({ date: '2026-11-20', time: null }, today, '12:00', '12h')).toEqual({ text: 'Nov 20', tone: 'later' });
  });

  it('is overdue once the day or the time has passed', () => {
    expect(dueLabel({ date: '2026-11-03', time: null }, today, '12:00', '12h')).toEqual({ text: 'Yesterday', tone: 'overdue' });
    expect(dueLabel({ date: '2026-11-04', time: '09:00' }, today, '12:00', '12h')).toEqual({ text: 'Today 9a', tone: 'overdue' });
    expect(dueLabel({ date: '2026-11-04', time: '17:00' }, today, '12:00', '24h')).toEqual({ text: 'Today 17:00', tone: 'today' });
    expect(dueLabel({ date: '2026-11-01', time: null }, today, '12:00', '12h').text).toBe('Last Sun');
  });

  it('formats times like the wall calendar', () => {
    expect(formatTime('00:00', '12h')).toBe('12a');
    expect(formatTime('12:05', '12h')).toBe('12:05p');
    expect(formatTime('07:00', '24h')).toBe('07:00');
  });
});

describe('the list address', () => {
  it('adds the trailing slash and a scheme', () => {
    expect(parseListUrl('192.168.1.14:5232/family/household')).toBe('http://192.168.1.14:5232/family/household/');
  });

  it('refuses localhost, which the host proxy blocks', () => {
    expect(parseListUrl('http://localhost:5232/family/household/')).toBe('loopback');
    expect(parseListUrl('http://127.0.0.1:5232/family/household/')).toBe('loopback');
  });

  it('needs a path to a list', () => {
    expect(parseListUrl('http://192.168.1.14:5232/')).toBe('notALink');
    expect(parseListUrl('  ')).toBe('empty');
  });

  it('encodes passwords with accents', () => {
    expect(basicAuth('display', 'café')).toBe('Basic ZGlzcGxheTpjYWbDqQ==');
  });
});

// Recorded from Radicale 3.9: a Depth 1 PROPFIND on the family account,
// holding two reminders lists (one with the phone's color and order) and an
// event calendar.
describe("finding an account's lists", () => {
  const ACCOUNT = 'http://192.168.1.14:5232/family/';
  const lists = parseLists(propfind, ACCOUNT);

  it('keeps reminders lists and skips the account and event calendars', () => {
    expect(lists.map((l) => l.name).sort()).toEqual(['Groceries & more', 'Household']);
  });

  it('makes full addresses and reads color and order', () => {
    const household = lists.find((l) => l.name === 'Household')!;
    expect(household).toEqual({ url: 'http://192.168.1.14:5232/family/household/', name: 'Household', color: '#34c759', order: 1 });
    const groceries = lists.find((l) => l.name.startsWith('Groceries'))!;
    expect(groceries.url).toBe('http://192.168.1.14:5232/family/7F1C2A9E-1111-4C2B-9D3E-ABCDEF012345/');
  });

  it("ignores properties the server didn't have", () => {
    const xml = propfind.replace('<ICAL:calendar-order>2</ICAL:calendar-order>', '');
    expect(parseLists(xml, ACCOUNT).find((l) => l.name.startsWith('Groceries'))!.order).toBeNull();
  });

  it("orders lists the phone's way, or as named", () => {
    const l = [
      { url: 'a', name: 'Zed', color: null, order: null },
      { url: 'b', name: 'Groceries', color: null, order: 2 },
      { url: 'c', name: 'Household', color: null, order: 1 },
      { url: 'd', name: 'Alpha', color: null, order: null },
    ];
    expect(chooseLists(l, []).map((x) => x.name)).toEqual(['Household', 'Groceries', 'Alpha', 'Zed']);
    expect(chooseLists(l, ['zed', 'Household', 'Missing']).map((x) => x.name)).toEqual(['Zed', 'Household']);
  });

  it("turns Apple's RGBA colors into CSS ones", () => {
    expect(normalizeColor('#FF9500FF')).toBe('#ff9500');
    expect(normalizeColor('#1badf8')).toBe('#1badf8');
    expect(normalizeColor('blue')).toBeNull();
  });

  it("asks the helper, on Radicale's port plus one, with the login", async () => {
    expect(helperUrl(ACCOUNT)).toBe('http://192.168.1.14:5233/family/');
    let seen: Parameters<Fetcher>[0] | null = null;
    const fetch: Fetcher = async (req) => { seen = req; return { status: 207, body: propfind }; };
    expect(await discoverLists(fetch, ACCOUNT, 'display', 'pw')).toHaveLength(2);
    expect(seen!.url).toBe('http://192.168.1.14:5233/family/');
    expect(seen!.method ?? 'GET').toBe('GET');
    expect(seen!.headers?.Authorization).toBe(basicAuth('display', 'pw'));
  });

  it('still points list addresses at Radicale itself', async () => {
    const fetch: Fetcher = async () => ({ status: 207, body: propfind });
    const lists = await discoverLists(fetch, ACCOUNT, 'display', 'pw');
    expect(lists.every((l) => l.url.startsWith('http://192.168.1.14:5232/family/'))).toBe(true);
  });

  it('tells a missing helper apart from a wrong password', async () => {
    const down: Fetcher = async () => ({ status: 502, body: '{"error":"connect ECONNREFUSED 192.168.1.14:5233"}' });
    await expect(discoverLists(down, ACCOUNT, 'display', 'pw')).rejects.toMatchObject({ failure: { kind: 'cantList' } });
    const thrown: Fetcher = async () => { throw new TypeError('Failed to fetch'); };
    await expect(discoverLists(thrown, ACCOUNT, 'display', 'pw')).rejects.toMatchObject({ failure: { kind: 'cantList' } });
    const denied: Fetcher = async () => ({ status: 401, body: 'Access to the requested resource forbidden.' });
    await expect(discoverLists(denied, ACCOUNT, 'display', 'pw')).rejects.toMatchObject({ failure: { kind: 'login' } });
    const other: Fetcher = async () => ({ status: 403, body: 'Access to the requested resource forbidden.' });
    await expect(discoverLists(other, ACCOUNT, 'display', 'pw')).rejects.toBeInstanceOf(ListError);
  });
});

describe('the address setting', () => {
  it('reads an account address as "every list"', () => {
    expect(parseSource('http://192.168.1.14:5232/family')).toEqual({ kind: 'account', url: 'http://192.168.1.14:5232/family/' });
  });

  it('reads one or more list addresses', () => {
    expect(parseSource('http://192.168.1.14:5232/family/household/')).toEqual({ kind: 'lists', urls: ['http://192.168.1.14:5232/family/household/'] });
    expect(parseSource('192.168.1.14:5232/family/a/,\n 192.168.1.14:5232/family/b')).toEqual({
      kind: 'lists', urls: ['http://192.168.1.14:5232/family/a/', 'http://192.168.1.14:5232/family/b/'],
    });
  });

  it('passes on problems', () => {
    expect(parseSource('')).toBe('empty');
    expect(parseSource('http://localhost:5232/family/')).toBe('loopback');
  });
});

describe('fitting several lists', () => {
  it('trims the longest list first, the later one on a tie', () => {
    expect(trimOne([5, 2, 5])).toEqual([5, 2, 4]);
    expect(trimOne([1, 0])).toEqual([0, 0]);
    expect(trimOne([0, 0])).toBeNull();
  });
});
