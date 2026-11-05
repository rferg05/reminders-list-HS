// Reading one list from Radicale. A plain GET on the list's address returns
// the whole list as an iCalendar file, so no CalDAV queries are needed.
//
// It goes through the host proxy, because Radicale sends no CORS headers and
// the display's browser can't read it directly. The proxy refuses loopback
// addresses, so the list's address must use the Pi's LAN address
// (192.168.1.14), not localhost, even though Radicale runs on the same Pi.

import { parseTaskList } from './ical';
import type { TaskList } from './ical';

export const PLUGIN_ID = 'reminders-list';

// ── Fetch plumbing ──────────────────────────────────────────────────────────

export interface ProxyRequest {
  url: string;
  method?: 'GET';
  headers?: Record<string, string>;
}

export interface ProxyAnswer {
  status: number;
  body: string;
}

export type Fetcher = (req: ProxyRequest) => Promise<ProxyAnswer>;

export function hostFetcher(): Fetcher {
  return async (req) => {
    const sdk = window.__HS_SDK__;
    if (!sdk?.pluginFetch) throw new Error('Host SDK unavailable');
    const res = await sdk.pluginFetch(PLUGIN_ID, req);
    return { status: res.status, body: await res.text() };
  };
}

// ── The list's address ──────────────────────────────────────────────────────

export type UrlProblem = 'empty' | 'notALink' | 'loopback';

/** `http://192.168.1.14:5232/family/household/`, with a trailing slash. */
export function parseListUrl(input: string): string | UrlProblem {
  const text = input.trim();
  if (!text) return 'empty';
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `http://${text}`);
  } catch {
    return 'notALink';
  }
  if (!/^https?:$/.test(url.protocol) || url.pathname.replace(/\/+$/, '') === '') return 'notALink';
  if (/^(localhost|127\.|\[?::1\]?$)/i.test(url.hostname)) return 'loopback';
  url.hash = '';
  url.search = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.toString();
}

/** UTF-8 safe, unlike a bare `btoa` on a password with an accent in it. */
export function basicAuth(user: string, password: string): string {
  const bytes = new TextEncoder().encode(`${user}:${password}`);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `Basic ${btoa(bin)}`;
}

// ── Loading ─────────────────────────────────────────────────────────────────

export type Failure =
  | { kind: 'unreachable' } // no answer from Radicale at all
  | { kind: 'proxy'; message: string } // the host proxy refused the request
  | { kind: 'login' } // wrong user name or password
  | { kind: 'forbidden' } // the account may not read this list
  | { kind: 'notFound' } // no list at that address
  | { kind: 'notAList' } // an answer, but not an iCalendar file
  | { kind: 'unexpected'; status: number };

export class ListError extends Error {
  constructor(public failure: Failure) {
    super(failure.kind);
  }
}

function failureOf(a: ProxyAnswer): Failure {
  const text = a.body.slice(0, 500);
  // The host proxy answers 403 for its own refusals, with a JSON reason.
  if (/allowedDomains|blocked address|not installed|manifest not found|not allowed|localNetwork/i.test(text)) {
    return { kind: 'proxy', message: text.replace(/^[{"\s]*(error|message)"?\s*:\s*"?|["}\s]*$/g, '').trim() };
  }
  if (a.status === 401) return { kind: 'login' };
  if (a.status === 403) return { kind: 'forbidden' };
  if (a.status === 404) return { kind: 'notFound' };
  if (/unreachable|timeout|timed out|ECONNREFUSED|EHOSTUNREACH|ENOTFOUND/i.test(text) || a.status >= 500) return { kind: 'unreachable' };
  return { kind: 'unexpected', status: a.status };
}

export async function loadList(fetch: Fetcher, url: string, user: string, password: string, tz: string): Promise<TaskList> {
  const headers: Record<string, string> = { Accept: 'text/calendar' };
  if (user) headers.Authorization = basicAuth(user, password);
  let answer: ProxyAnswer;
  try {
    answer = await fetch({ url, headers });
  } catch {
    throw new ListError({ kind: 'unreachable' });
  }
  if (answer.status < 200 || answer.status >= 300) throw new ListError(failureOf(answer));
  if (!/BEGIN:VCALENDAR/i.test(answer.body)) throw new ListError({ kind: 'notAList' });
  return parseTaskList(answer.body, tz);
}
