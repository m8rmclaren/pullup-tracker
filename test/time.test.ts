import { describe, expect, it } from 'vitest';
import { addDays, dayKey, daysBetween, formatClock, isValidTimeZone, monthKey, msUntilNextDay, startOfWeek, timeOfDay, wallClockToEpochMs } from '../src/shared/time';
import { instantMs, loadFixture } from './fixtures';

interface DaysFixture {
  dayKeys: { name: string; at: string; timeZone: string; day: string }[];
  wallClockToInstant: { name: string; day: string; time: string; timeZone: string; at: string }[];
  timeOfDay: { name: string; at: string; timeZone: string; time: string }[];
  msUntilNextDay: { name: string; at: string; timeZone: string; ms: number }[];
  addDays: { day: string; days: number; result: string }[];
  daysBetween: { fromDay: string; toDay: string; days: number }[];
  startOfWeek: { name: string; day: string; result: string }[];
}

const fixture = loadFixture<DaysFixture>('days.json');

describe('days.json', () => {
  it.each(fixture.dayKeys)('dayKey: $name ($at in $timeZone)', ({ at, timeZone, day }) => {
    expect(dayKey(instantMs(at), timeZone)).toBe(day);
  });

  it.each(fixture.wallClockToInstant)('wallClockToEpochMs: $name ($day $time in $timeZone)', ({ day, time, timeZone, at }) => {
    expect(wallClockToEpochMs(day, time, timeZone)).toBe(instantMs(at));
  });

  it.each(fixture.timeOfDay)('timeOfDay: $name', ({ at, timeZone, time }) => {
    expect(timeOfDay(instantMs(at), timeZone)).toBe(time);
  });

  it.each(fixture.msUntilNextDay)('msUntilNextDay: $name', ({ at, timeZone, ms }) => {
    expect(msUntilNextDay(instantMs(at), timeZone)).toBe(ms);
  });

  it.each(fixture.addDays)('addDays($day, $days)', ({ day, days, result }) => {
    expect(addDays(day, days)).toBe(result);
  });

  it.each(fixture.daysBetween)('daysBetween($fromDay, $toDay)', ({ fromDay, toDay, days }) => {
    expect(daysBetween(fromDay, toDay)).toBe(days);
  });

  it.each(fixture.startOfWeek)('startOfWeek: $name', ({ day, result }) => {
    expect(startOfWeek(day)).toBe(result);
  });
});

describe('time formatting', () => {
  it('derives the month key from the day key', () => {
    expect(monthKey(Date.parse('2026-11-01T05:59:00Z'), 'America/Denver')).toBe('2026-10');
    expect(monthKey(Date.parse('2026-11-01T06:00:00Z'), 'America/Denver')).toBe('2026-11');
  });

  it('formats a 12-hour clock', () => {
    expect(formatClock(Date.parse('2026-10-08T06:05:00Z'), 'America/Denver')).toBe('12:05a');
    expect(formatClock(Date.parse('2026-10-08T19:30:00Z'), 'America/Denver')).toBe('1:30p');
    expect(formatClock(Date.parse('2026-10-08T19:30:00Z'), 'Asia/Kolkata')).toBe('1:00a');
  });

  it('accepts only zones the runtime knows', () => {
    expect(isValidTimeZone('Europe/London')).toBe(true);
    expect(isValidTimeZone('America/Denver')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
  });
});
