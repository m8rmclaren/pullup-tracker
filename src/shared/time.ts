// All calendar math happens in one fixed zone, regardless of where the device is.
// Day keys are 'YYYY-MM-DD' strings; arithmetic on them is pure calendar math in
// UTC so DST never shifts a day.

export const TZ = 'America/Denver';

const DAY_MS = 86_400_000;

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

interface WallParts {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

function wallParts(ts: number): WallParts {
  const out: Record<string, number> = {};
  for (const p of partsFmt.formatToParts(ts)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return {
    y: out.year!,
    mo: out.month!,
    d: out.day!,
    h: out.hour! % 24,
    mi: out.minute!,
    s: out.second!,
  };
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function dayKey(ts: number): string {
  const p = wallParts(ts);
  return `${pad(p.y, 4)}-${pad(p.mo)}-${pad(p.d)}`;
}

export function monthKey(ts: number): string {
  return dayKey(ts).slice(0, 7);
}

/** Denver wall-clock time minus UTC, in ms (e.g. -6h in summer, -7h in winter). */
export function tzOffsetMs(ts: number): number {
  const p = wallParts(ts);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/**
 * Epoch ms for a Denver wall-clock time. A time skipped by spring-forward resolves
 * an hour later (2:30 → 3:30), as clocks do; an ambiguous fall-back time resolves to the
 * first (daylight) occurrence.
 */
export function wallToEpoch(day: string, hhmm: string): number {
  const [y, mo, d] = day.split('-').map(Number) as [number, number, number];
  const [h, mi] = hhmm.split(':').map(Number) as [number, number];
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  const first = naive - tzOffsetMs(naive - 12 * 3_600_000);
  const second = naive - tzOffsetMs(naive + 12 * 3_600_000);
  for (const candidate of [first, second].sort((a, b) => a - b)) {
    const p = wallParts(candidate);
    if (p.h === h && p.mi === mi && dayKey(candidate) === day) return candidate;
  }
  return Math.max(first, second);
}

export function timeOfDay(ts: number): string {
  const p = wallParts(ts);
  return `${pad(p.h)}:${pad(p.mi)}`;
}

function dayToUtc(day: string): number {
  const [y, mo, d] = day.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, mo - 1, d);
}

function utcToDay(ms: number): string {
  const dt = new Date(ms);
  return `${pad(dt.getUTCFullYear(), 4)}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function addDays(day: string, n: number): string {
  return utcToDay(dayToUtc(day) + n * DAY_MS);
}

/** Whole days from a to b (b - a). */
export function dayDiff(a: string, b: string): number {
  return Math.round((dayToUtc(b) - dayToUtc(a)) / DAY_MS);
}

/** 0 = Monday … 6 = Sunday. */
export function weekdayMon0(day: string): number {
  return (new Date(dayToUtc(day)).getUTCDay() + 6) % 7;
}

export function startOfWeek(day: string): string {
  return addDays(day, -weekdayMon0(day));
}

/** Ms until the next Denver midnight after `ts`. */
export function msUntilNextDay(ts: number): number {
  const next = wallToEpoch(addDays(dayKey(ts), 1), '00:00');
  return Math.max(1000, next - ts);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function formatDay(day: string, opts: { weekday?: boolean; year?: boolean } = {}): string {
  const [y, mo, d] = day.split('-').map(Number) as [number, number, number];
  let s = `${MONTHS[mo - 1]} ${d}`;
  if (opts.weekday) s = `${WEEKDAYS[weekdayMon0(day)]}, ${s}`;
  if (opts.year) s += `, ${y}`;
  return s;
}

export function formatClock(ts: number): string {
  const p = wallParts(ts);
  const h12 = p.h % 12 === 0 ? 12 : p.h % 12;
  return `${h12}:${pad(p.mi)}${p.h < 12 ? 'a' : 'p'}`;
}
