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
// Radicale unreachable, and any config key (`sortBy=due`, `keepDoneHours=6`).
const params = new URLSearchParams(location.search);
const timezone = params.get('tz') ?? 'America/Chicago';
(window as unknown as { React: typeof React }).React = React;
(window as unknown as { __HS_SDK__: unknown }).__HS_SDK__ = {
  displayCache: makeHostDisplayCache(),
  emit: (e: unknown) => console.info('[host emit]', e),
};

// ── A fake Radicale list, written the way the Reminders app writes it ──────

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

const ics = () => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//PYVOBJECT//NONSGML Version 0.9.9//EN', 'X-WR-CALNAME;VALUE=TEXT:Household',
  ...items.flatMap((i) => ['BEGIN:VTODO', `UID:${i.uid}`, 'DTSTAMP:20261104T120000Z', ...i.lines, 'END:VTODO']),
  'END:VCALENDAR', '',
].join('\r\n');

let down = params.get('fail') === '1';
const devFetcher: Fetcher = async (req) => {
  await new Promise((r) => setTimeout(r, 150));
  if (down) throw new Error('ECONNREFUSED');
  if (req.headers?.Authorization !== `Basic ${btoa('display:preview')}`) return { status: 401, body: 'Access to the requested resource forbidden.' };
  return { status: 200, body: ics() };
};

const style = {
  fontSize: Number(params.get('fs') ?? manifest.defaultStyle.fontSize), fontFamily: 'inter', textColor: '#ffffff',
  backgroundColor: manifest.defaultStyle.backgroundColor, borderRadius: manifest.defaultStyle.borderRadius,
  padding: manifest.defaultStyle.padding, opacity: 1, backdropBlur: 12,
};
const config: Record<string, unknown> = {
  ...manifest.defaultConfig,
  listUrl: 'http://192.168.1.14:5232/family/household/',
  password: 'preview',
  refreshSeconds: 15,
  keepDoneHours: 2,
  ...Object.fromEntries([...params].filter(([k]) => !['w', 'h', 'fs', 'tz', 'fail'].includes(k))),
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
