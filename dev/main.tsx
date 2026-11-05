import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import manifest from '../manifest.json';
import RemindersList from '../src/index';
import { addDays } from '../src/tasks';
import { wallClock } from '../src/ical';
import type { Fetcher } from '../src/radicale';
import { makeHostDisplayCache } from './host-cache';

// Stand-in for the host: just enough SDK for the module to run.
// `?w=&h=` module size, `fs=` text size, `tz=`, `fail=1` to start with
// Radicale unreachable, `nohelper=1` for a Pi without the radicale-lists helper, and
// any config key (`listUrl=http://192.168.1.14:5232/family/household/` for
// one list, `onlyLists=Groceries`, `sortBy=due`, `keepDoneHours=6`).
const params = new URLSearchParams(location.search);
const timezone = params.get('tz') ?? 'America/Chicago';
(window as unknown as { React: typeof React }).React = React;
(window as unknown as { __HS_SDK__: unknown }).__HS_SDK__ = {
  displayCache: makeHostDisplayCache(),
  emit: (e: unknown) => console.info('[host emit]', e),
};

// ── Fake Radicale lists, written the way the Reminders app writes them ─────

const today = wallClock(Date.now(), timezone).date;
const ymd = (days: number) => addDays(today, days).replace(/-/g, '');
const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]|\.\d+/g, '');

interface Item { uid: string; lines: string[] }
let order = 0;
const item = (uid: string, title: string, ...extra: string[]): Item => ({
  uid, lines: [`SUMMARY:${title.replace(/,/g, '\\,')}`, `X-APPLE-SORT-ORDER:${(order += 10)}`, ...extra],
});

let items: Item[] = [
  item('milk', 'Milk, eggs, bread'),
  item('water', 'Pay water bill', `DUE;TZID=${timezone}:${ymd(0)}T170000`, 'PRIORITY:1', 'DESCRIPTION:Online at the city site\\nacct in 1Password'),
  item('plumber', 'Call the plumber about the upstairs bathroom sink that keeps dripping', `DUE;TZID=${timezone}:${ymd(0)}T090000`),
  item('library', 'Return library books', `DUE;VALUE=DATE:${ymd(2)}`),
  item('gifts', 'Birthday gifts for Gabby', `DUE;VALUE=DATE:${ymd(9)}`, 'PRIORITY:5'),
  item('wrap', 'Wrapping paper', 'RELATED-TO;RELTYPE=PARENT:gifts'),
  item('card', 'Card', 'RELATED-TO;RELTYPE=PARENT:gifts'),
  item('filters', 'Change furnace filter', `DUE;VALUE=DATE:${ymd(-2)}`),
  item('flu', 'Book flu shots', 'PRIORITY:9'),
  item('lightbulbs', 'Lightbulbs for the porch'),
  item('trash', 'Trash out', 'STATUS:COMPLETED', `COMPLETED:${stamp(Date.now() - 40 * 60_000)}`),
];

const groceries: Item[] = [
  item('g1', 'Coffee beans'),
  item('g2', 'Bananas'),
  item('g3', 'Dish soap', 'PRIORITY:5'),
  item('g4', 'Parmesan'),
];

const ACCOUNT = 'http://192.168.1.14:5232/family/';
const HELPER = 'http://192.168.1.14:5233/family/';
// As the phones made them: Household by the installer, the others in the
// Reminders app, so with random folder names, colors and an order.
const lists = [
  { path: 'household/', name: 'Household', color: '#34C759FF', order: 1, items: () => items },
  { path: '5C2E9A10-7B3D-4E21-9F00-1A2B3C4D5E6F/', name: 'Groceries', color: '#FF9500FF', order: 2, items: () => groceries },
  { path: 'A41F0C2E-55D1-4B7A-8C3E-0F9E8D7C6B5A/', name: 'Packing', color: '#AF52DEFF', order: 3, items: () => [] as Item[] },
];

const ics = (name: string, list: Item[]) => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//PYVOBJECT//NONSGML Version 0.9.9//EN', `X-WR-CALNAME;VALUE=TEXT:${name}`,
  ...list.flatMap((i) => ['BEGIN:VTODO', `UID:${i.uid}`, 'DTSTAMP:20261104T120000Z', ...i.lines, 'END:VTODO']),
  'END:VCALENDAR', '',
].join('\r\n');

const multistatus = () =>
  `<?xml version='1.0' encoding='utf-8'?><multistatus xmlns="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:ICAL="http://apple.com/ns/ical/">` +
  `<response><href>/family/</href><propstat><prop><resourcetype><principal /><collection /></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>` +
  lists.map((l) => `<response><href>/family/${l.path}</href><propstat><prop><resourcetype><C:calendar /><collection /></resourcetype>` +
    `<displayname>${l.name}</displayname><C:supported-calendar-component-set><C:comp name="VTODO" /></C:supported-calendar-component-set>` +
    `<ICAL:calendar-color>${l.color}</ICAL:calendar-color><ICAL:calendar-order>${l.order}</ICAL:calendar-order></prop>` +
    `<status>HTTP/1.1 200 OK</status></propstat></response>`).join('') +
  '</multistatus>';

const LOGIN = `Basic ${btoa('display:preview')}`;
let down = params.get('fail') === '1';
const devFetcher: Fetcher = async (req) => {
  await new Promise((r) => setTimeout(r, 150));
  if (down) throw new Error('ECONNREFUSED');
  if (req.headers?.Authorization !== LOGIN) return { status: 401, body: 'Access to the requested resource forbidden.' };
  // The radicale-lists helper, on the next port up.
  if (req.url === HELPER) {
    return params.get('nohelper') === '1'
      ? { status: 502, body: '{"error":"connect ECONNREFUSED 192.168.1.14:5233"}' }
      : { status: 207, body: multistatus() };
  }
  const list = lists.find((l) => req.url === ACCOUNT + l.path);
  return list ? { status: 200, body: ics(list.name, list.items()) } : { status: 404, body: 'The requested resource could not be found.' };
};

const style = {
  fontSize: Number(params.get('fs') ?? manifest.defaultStyle.fontSize), fontFamily: 'inter', textColor: '#ffffff',
  backgroundColor: manifest.defaultStyle.backgroundColor, borderRadius: manifest.defaultStyle.borderRadius,
  padding: manifest.defaultStyle.padding, opacity: 1, backdropBlur: 12,
};
const config: Record<string, unknown> = {
  ...manifest.defaultConfig,
  listUrl: ACCOUNT,
  password: 'preview',
  refreshSeconds: 15,
  keepDoneHours: 2,
  ...Object.fromEntries([...params].filter(([k]) => !['w', 'h', 'fs', 'tz', 'fail', 'nohelper'].includes(k))),
};

/** The module at a size you can change, plus buttons that act like a phone. */
function Harness() {
  const [w, setW] = useState(Number(params.get('w') ?? manifest.defaultSize.w));
  const [h, setH] = useState(Number(params.get('h') ?? manifest.defaultSize.h));
  const [mount, bump] = useState(0);
  useEffect(() => {
    (window as unknown as { setBox: unknown }).setBox = (nw: number, nh: number) => { setW(nw); setH(nh); };
  }, []);
  // Remounting, as a screen rotating back in does, makes the module ask the
  // fake Radicale again now rather than at the next refresh.
  const changed = () => bump((n) => n + 1);
  const add = () => { items.push(item(`n${Date.now()}`, `New item ${items.length + 1}`)); changed(); };
  const check = () => {
    const open = items.find((i) => !i.lines.some((l) => l.startsWith('STATUS:COMPLETED')));
    if (open) open.lines.push('STATUS:COMPLETED', `COMPLETED:${stamp(Date.now())}`);
    changed();
  };
  const toggleDown = () => { down = !down; changed(); };
  const btn = { font: 'inherit', padding: '4px 10px', borderRadius: 6, border: '1px solid #fff4', background: '#0006', color: '#fff', cursor: 'pointer' };
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, color: '#fff', fontSize: 13, alignItems: 'center', flexWrap: 'wrap' }}>
        {[[520, 640], [960, 540], [1280, 360], [380, 300]].map(([bw, bh]) => (
          <button key={`${bw}x${bh}`} style={btn} onClick={() => { setW(bw); setH(bh); }}>{bw}×{bh}</button>
        ))}
        <button style={btn} onClick={add}>Phone: add item</button>
        <button style={btn} onClick={check}>Phone: check one off</button>
        <button style={btn} onClick={toggleDown}>{down ? 'Bring Radicale back' : 'Stop Radicale'}</button>
        <span>{w}×{h}</span>
      </div>
      <div id="module" style={{ width: w, height: h, resize: 'both', overflow: 'hidden' }}>
        <RemindersList key={mount} config={config} style={style} timezone={timezone} fetcher={devFetcher} />
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
