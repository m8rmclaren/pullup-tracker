// All calendar math happens in one fixed zone, regardless of where the device is.
// Day keys are 'YYYY-MM-DD' strings; arithmetic on them is pure calendar math in
// UTC so DST never shifts a day.

export const TIME_ZONE = 'America/Denver';

const DAY_MS = 86_400_000;

const wallClockFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function denverWallClock(epochMs: number): WallClock {
  const valuesByType: Record<string, number> = {};
  for (const part of wallClockFormatter.formatToParts(epochMs)) {
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

export function dayKey(epochMs: number): string {
  const wallClock = denverWallClock(epochMs);
  return `${pad(wallClock.year, 4)}-${pad(wallClock.month)}-${pad(wallClock.day)}`;
}

export function monthKey(epochMs: number): string {
  return dayKey(epochMs).slice(0, 7);
}

/** Denver wall-clock time minus UTC, in ms (e.g. -6h in summer, -7h in winter). */
export function denverOffsetMs(epochMs: number): number {
  const wallClock = denverWallClock(epochMs);
  const asUtc = Date.UTC(wallClock.year, wallClock.month - 1, wallClock.day, wallClock.hour, wallClock.minute, wallClock.second);
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

/**
 * Epoch ms for a Denver wall-clock time. A time skipped by spring-forward resolves
 * an hour later (2:30 → 3:30), as clocks do; an ambiguous fall-back time resolves to the
 * first (daylight) occurrence.
 */
export function wallClockToEpochMs(day: string, hhmm: string): number {
  const [year, month, dayOfMonth] = day.split('-').map(Number) as [number, number, number];
  const [hour, minute] = hhmm.split(':').map(Number) as [number, number];
  const naiveUtcMs = Date.UTC(year, month - 1, dayOfMonth, hour, minute);
  const viaEarlierOffset = naiveUtcMs - denverOffsetMs(naiveUtcMs - 12 * 3_600_000);
  const viaLaterOffset = naiveUtcMs - denverOffsetMs(naiveUtcMs + 12 * 3_600_000);
  for (const candidate of [viaEarlierOffset, viaLaterOffset].sort((a, b) => a - b)) {
    const wallClock = denverWallClock(candidate);
    if (wallClock.hour === hour && wallClock.minute === minute && dayKey(candidate) === day) return candidate;
  }
  return Math.max(viaEarlierOffset, viaLaterOffset);
}

export function timeOfDay(epochMs: number): string {
  const wallClock = denverWallClock(epochMs);
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

/** Ms until the next Denver midnight after `epochMs`. */
export function msUntilNextDay(epochMs: number): number {
  const nextMidnightMs = wallClockToEpochMs(addDays(dayKey(epochMs), 1), '00:00');
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

export function formatClock(epochMs: number): string {
  const wallClock = denverWallClock(epochMs);
  const hour12 = wallClock.hour % 12 === 0 ? 12 : wallClock.hour % 12;
  return `${hour12}:${pad(wallClock.minute)}${wallClock.hour < 12 ? 'a' : 'p'}`;
}
