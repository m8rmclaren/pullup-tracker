// Day keys are 'YYYY-MM-DD' strings in a user's own IANA zone. Arithmetic on them is pure
// calendar math in UTC, so DST never shifts a day.

/** The zone of every account made before zones were per user; their stored day keys are in it. */
export const DEFAULT_TIME_ZONE = 'America/Denver';

const DAY_MS = 86_400_000;

const formattersByZone = new Map<string, Intl.DateTimeFormat>();

function wallClockFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formattersByZone.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    formattersByZone.set(timeZone, formatter);
  }
  return formatter;
}

export const MAX_TIME_ZONE_LENGTH = 64;

/** True for an IANA zone name this runtime knows. */
export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TIME_ZONE_LENGTH) return false;
  try {
    wallClockFormatter(value);
    return true;
  } catch {
    return false;
  }
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallClockAt(epochMs: number, timeZone: string): WallClock {
  const valuesByType: Record<string, number> = {};
  for (const part of wallClockFormatter(timeZone).formatToParts(epochMs)) {
    if (part.type !== 'literal') valuesByType[part.type] = Number(part.value);
  }
  return {
    year: valuesByType.year!,
    month: valuesByType.month!,
    day: valuesByType.day!,
    hour: valuesByType.hour! % 24,
    minute: valuesByType.minute!,
    second: valuesByType.second!,
  };
}

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

export function dayKey(epochMs: number, timeZone: string): string {
  const wallClock = wallClockAt(epochMs, timeZone);
  return `${pad(wallClock.year, 4)}-${pad(wallClock.month)}-${pad(wallClock.day)}`;
}

export function monthKey(epochMs: number, timeZone: string): string {
  return dayKey(epochMs, timeZone).slice(0, 7);
}

/** Wall-clock time in `timeZone` minus UTC, in ms (e.g. -6h for Denver in summer). */
export function zoneOffsetMs(epochMs: number, timeZone: string): number {
  const wallClock = wallClockAt(epochMs, timeZone);
  const asUtc = Date.UTC(wallClock.year, wallClock.month - 1, wallClock.day, wallClock.hour, wallClock.minute, wallClock.second);
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/**
 * Epoch ms for a wall-clock time in `timeZone`. A time skipped by spring-forward resolves
 * an hour later (2:30 → 3:30), as clocks do; an ambiguous fall-back time resolves to the
 * first (daylight) occurrence.
 */
export function wallClockToEpochMs(day: string, hhmm: string, timeZone: string): number {
  const [year, month, dayOfMonth] = day.split('-').map(Number) as [number, number, number];
  const [hour, minute] = hhmm.split(':').map(Number) as [number, number];
  const naiveUtcMs = Date.UTC(year, month - 1, dayOfMonth, hour, minute);
  const viaEarlierOffset = naiveUtcMs - zoneOffsetMs(naiveUtcMs - 12 * 3_600_000, timeZone);
  const viaLaterOffset = naiveUtcMs - zoneOffsetMs(naiveUtcMs + 12 * 3_600_000, timeZone);
  for (const candidate of [viaEarlierOffset, viaLaterOffset].sort((a, b) => a - b)) {
    const wallClock = wallClockAt(candidate, timeZone);
    if (wallClock.hour === hour && wallClock.minute === minute && dayKey(candidate, timeZone) === day) return candidate;
  }
  return Math.max(viaEarlierOffset, viaLaterOffset);
}

export function timeOfDay(epochMs: number, timeZone: string): string {
  const wallClock = wallClockAt(epochMs, timeZone);
  return `${pad(wallClock.hour)}:${pad(wallClock.minute)}`;
}

function dayKeyToUtcMs(day: string): number {
  const [year, month, dayOfMonth] = day.split('-').map(Number) as [number, number, number];
  return Date.UTC(year, month - 1, dayOfMonth);
}

function utcMsToDayKey(utcMs: number): string {
  const date = new Date(utcMs);
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function addDays(day: string, days: number): string {
  return utcMsToDayKey(dayKeyToUtcMs(day) + days * DAY_MS);
}

/** Whole days from `fromDay` to `toDay` (toDay - fromDay). */
export function daysBetween(fromDay: string, toDay: string): number {
  return Math.round((dayKeyToUtcMs(toDay) - dayKeyToUtcMs(fromDay)) / DAY_MS);
}

/** 0 = Monday … 6 = Sunday. */
export function weekdayIndexFromMonday(day: string): number {
  return (new Date(dayKeyToUtcMs(day)).getUTCDay() + 6) % 7;
}

export function startOfWeek(day: string): string {
  return addDays(day, -weekdayIndexFromMonday(day));
}

/** Ms until the next midnight in `timeZone` after `epochMs`. */
export function msUntilNextDay(epochMs: number, timeZone: string): number {
  const nextMidnightMs = wallClockToEpochMs(addDays(dayKey(epochMs, timeZone), 1), '00:00', timeZone);
  return Math.max(1000, nextMidnightMs - epochMs);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function formatDay(day: string, options: { weekday?: boolean; year?: boolean } = {}): string {
  const [year, month, dayOfMonth] = day.split('-').map(Number) as [number, number, number];
  let label = `${MONTHS[month - 1]} ${dayOfMonth}`;
  if (options.weekday) label = `${WEEKDAYS[weekdayIndexFromMonday(day)]}, ${label}`;
  if (options.year) label += `, ${year}`;
  return label;
}

export function formatClock(epochMs: number, timeZone: string): string {
  const wallClock = wallClockAt(epochMs, timeZone);
  const hour12 = wallClock.hour % 12 === 0 ? 12 : wallClock.hour % 12;
  return `${hour12}:${pad(wallClock.minute)}${wallClock.hour < 12 ? 'a' : 'p'}`;
}
