import type { SortBy } from './tasks';

export type TimeFormatSetting = 'auto' | '12h' | '24h';
export type Columns = 'auto' | '1' | '2' | '3';

export interface Config {
  listUrl: string;
  username: string;
  password: string;
  title: string;
  showHeader: boolean;
  sortBy: SortBy;
  showDue: boolean;
  showNotes: boolean;
  showPriority: boolean;
  keepDoneHours: number;
  columns: Columns;
  textScale: number;
  accentColor: string;
  emptyText: string;
  timeFormat: TimeFormatSetting;
  refreshSeconds: number;
}

const pick = <T extends string>(v: unknown, options: readonly T[], fallback: T): T =>
  options.includes(v as T) ? (v as T) : fallback;

const num = (v: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

const bool = (v: unknown, fallback: boolean): boolean =>
  typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : fallback;

const str = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback);

export function readConfig(raw: Record<string, unknown>): Config {
  return {
    listUrl: str(raw.listUrl, '').trim(),
    username: str(raw.username, 'display').trim(),
    password: str(raw.password, ''),
    title: str(raw.title, '').trim(),
    showHeader: bool(raw.showHeader, true),
    sortBy: pick(raw.sortBy, ['phone', 'due'] as const, 'phone'),
    showDue: bool(raw.showDue, true),
    showNotes: bool(raw.showNotes, false),
    showPriority: bool(raw.showPriority, true),
    keepDoneHours: num(raw.keepDoneHours, 0, 0, 48),
    columns: pick(raw.columns, ['auto', '1', '2', '3'] as const, 'auto'),
    textScale: num(raw.textScale, 1, 0.5, 2.5),
    accentColor: str(raw.accentColor, '#f59e0b'),
    emptyText: str(raw.emptyText, 'All done'),
    timeFormat: pick(raw.timeFormat, ['auto', '12h', '24h'] as const, 'auto'),
    refreshSeconds: num(raw.refreshSeconds, 60, 15, 900),
  };
}
