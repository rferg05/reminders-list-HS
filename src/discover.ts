// Finding every reminders list in an account, so lists made on a phone show
// up without anyone copying their address.
//
// That takes a CalDAV PROPFIND, which the host proxy refuses (it only passes
// GET, POST, PUT and PATCH). So this one request goes from the display's
// browser straight to Radicale, which allows it once its config sends CORS
// headers (the installer adds them). The lists' contents still come through
// the proxy with a plain GET.

import { basicAuth, ListError } from './radicale';

export interface ListInfo {
  /** `http://192.168.1.14:5232/family/5C2E9A10-.../` */
  url: string;
  name: string;
  /** `#ff9500`, from the phone, or null. */
  color: string | null;
  /** The phone's order of lists, or null. */
  order: number | null;
}

export interface DirectAnswer {
  status: number;
  body: string;
}

export type DirectFetcher = (req: { url: string; method: 'PROPFIND'; headers: Record<string, string>; body: string }) => Promise<DirectAnswer>;

export function browserFetcher(): DirectFetcher {
  return async (req) => {
    const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, mode: 'cors', credentials: 'omit', cache: 'no-store' });
    return { status: res.status, body: await res.text() };
  };
}

export const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/">' +
  '<d:prop><d:resourcetype/><d:displayname/><c:supported-calendar-component-set/><a:calendar-color/><a:calendar-order/></d:prop>' +
  '</d:propfind>';

const unxml = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');

/** Elements by local name, whatever prefix the server gave the namespace. */
const elements = (xml: string, name: string) =>
  [...xml.matchAll(new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>)`, 'g'))].map((m) => m[1] ?? '');

const text = (xml: string, name: string) => {
  const found = elements(xml, name)[0];
  return found === undefined ? null : unxml(found).trim();
};

/** `#FF9500FF` (Apple's RGBA) to `#ff9500`. */
export function normalizeColor(v: string | null): string | null {
  const m = /^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec((v ?? '').trim());
  return m ? `#${m[1].toLowerCase()}` : null;
}

/** The reminders lists in a Depth 1 PROPFIND answer. Event calendars and
 *  the account folder itself are left out. Only properties the server
 *  answered with 200 count. */
export function parseLists(xml: string, accountUrl: string): ListInfo[] {
  const out: ListInfo[] = [];
  for (const response of elements(xml, 'response')) {
    const href = text(response, 'href');
    if (!href) continue;
    const ok = elements(response, 'propstat').filter((p) => /\s200\s/.test(text(p, 'status') ?? '')).join('');
    if (!/<(?:[\w-]+:)?calendar[\s/>]/.test(elements(ok, 'resourcetype')[0] ?? '')) continue;
    const comps = [...(elements(ok, 'supported-calendar-component-set')[0] ?? '').matchAll(/name="([^"]+)"/g)].map((m) => m[1].toUpperCase());
    // No component set means "anything": keep it only if it says VTODO.
    if (!comps.includes('VTODO')) continue;
    const url = new URL(href, accountUrl).toString();
    const order = Number(text(ok, 'calendar-order'));
    out.push({
      url: url.endsWith('/') ? url : `${url}/`,
      name: text(ok, 'displayname') || decodeURIComponent(url.replace(/\/$/, '').split('/').pop() ?? ''),
      color: normalizeColor(text(ok, 'calendar-color')),
      order: text(ok, 'calendar-order') !== null && Number.isFinite(order) ? order : null,
    });
  }
  return out;
}

export async function discoverLists(fetch: DirectFetcher, accountUrl: string, user: string, password: string): Promise<ListInfo[]> {
  const headers: Record<string, string> = { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' };
  if (user) headers.Authorization = basicAuth(user, password);
  let answer: DirectAnswer;
  try {
    answer = await fetch({ url: accountUrl, method: 'PROPFIND', headers, body: PROPFIND_BODY });
  } catch {
    // A browser hides why: Radicale down and Radicale without CORS
    // headers look the same from here.
    throw new ListError({ kind: 'cantList' });
  }
  if (answer.status === 401) throw new ListError({ kind: 'login' });
  if (answer.status === 403) throw new ListError({ kind: 'forbidden' });
  if (answer.status === 404) throw new ListError({ kind: 'notFound' });
  if (answer.status !== 207) throw new ListError({ kind: 'unexpected', status: answer.status });
  return parseLists(answer.body, accountUrl);
}

/** The phone's order of lists, then by name. With `only` names given, just
 *  those lists, in that order. */
export function chooseLists(lists: ListInfo[], only: string[]): ListInfo[] {
  if (only.length) {
    const key = (s: string) => s.trim().toLocaleLowerCase();
    return only.flatMap((name) => lists.filter((l) => key(l.name) === key(name)));
  }
  return [...lists].sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity) || a.name.localeCompare(b.name));
}
