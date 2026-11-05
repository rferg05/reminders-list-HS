// Finding every reminders list in an account, so lists made on a phone show
// up without anyone copying their address.
//
// That takes a CalDAV PROPFIND. Home Screens' proxy only passes GET, POST,
// PUT and PATCH, and its pages' Content Security Policy won't let a plugin
// call Radicale's plain-HTTP address directly. So a small helper on the Pi
// (radicale-lists, which the installer sets up beside Radicale) answers a
// GET on the same account folder, on the next port up, by sending Radicale
// the PROPFIND itself with the caller's login. Its answer is Radicale's.

import { basicAuth, failureOf, ListError } from './radicale';
import type { Fetcher, ProxyAnswer } from './radicale';

export interface ListInfo {
  /** `http://192.168.1.14:5232/family/5C2E9A10-.../` */
  url: string;
  name: string;
  /** `#ff9500`, from the phone, or null. */
  color: string | null;
  /** The phone's order of lists, or null. */
  order: number | null;
}

/** The helper listens on Radicale's port plus one. */
export const HELPER_PORT_OFFSET = 1;

/** `http://192.168.1.14:5232/family/` to `http://192.168.1.14:5233/family/`. */
export function helperUrl(accountUrl: string): string {
  const u = new URL(accountUrl);
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  u.port = String(port + HELPER_PORT_OFFSET);
  return u.toString();
}

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

export async function discoverLists(fetch: Fetcher, accountUrl: string, user: string, password: string): Promise<ListInfo[]> {
  const headers: Record<string, string> = { Accept: 'application/xml' };
  if (user) headers.Authorization = basicAuth(user, password);
  let answer: ProxyAnswer;
  try {
    answer = await fetch({ url: helperUrl(accountUrl), headers });
  } catch {
    throw new ListError({ kind: 'cantList' });
  }
  // Radicale answers 207; accept any success in case the proxy rewrites it.
  if (answer.status >= 200 && answer.status < 300 && /multistatus/i.test(answer.body)) return parseLists(answer.body, accountUrl);
  const failure = failureOf(answer);
  // Nothing answering on the helper's port: the proxy reports it as an
  // error of its own, which reads as "unreachable".
  throw new ListError(failure.kind === 'unreachable' || failure.kind === 'unexpected' ? { kind: 'cantList' } : failure);
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
