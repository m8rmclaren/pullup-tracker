import { describe, expect, it } from 'vitest';
import { addDays, dayKey, daysBetween, formatClock, monthKey, msUntilNextDay, startOfWeek, timeOfDay, wallClockToEpochMs } from '../src/shared/time';

const utcMs = (iso: string) => Date.parse(iso);

describe('dayKey (America/Denver)', () => {
  it('rolls over at Denver midnight, not UTC midnight (MDT, UTC-6)', () => {
    expect(dayKey(utcMs('2026-10-08T05:59:59Z'))).toBe('2026-10-07');
    expect(dayKey(utcMs('2026-10-08T06:00:00Z'))).toBe('2026-10-08');
  });

  it('rolls over at 07:00Z in winter (MST, UTC-7)', () => {
    expect(dayKey(utcMs('2026-01-15T06:59:59Z'))).toBe('2026-01-14');
    expect(dayKey(utcMs('2026-01-15T07:00:00Z'))).toBe('2026-01-15');
  });

  it('keeps an evening session on one day even though it crosses UTC midnight', () => {
    expect(dayKey(utcMs('2026-10-07T23:00:00Z'))).toBe('2026-10-07'); // 5pm
    expect(dayKey(utcMs('2026-10-08T01:00:00Z'))).toBe('2026-10-07'); // 7pm
  });

  it('puts the last minute of a month in that month', () => {
    expect(monthKey(utcMs('2026-11-01T05:59:00Z'))).toBe('2026-10');
    expect(monthKey(utcMs('2026-11-01T06:00:00Z'))).toBe('2026-11');
  });

  it('handles the year boundary', () => {
    expect(dayKey(utcMs('2027-01-01T06:59:00Z'))).toBe('2026-12-31');
    expect(dayKey(utcMs('2027-01-01T07:00:00Z'))).toBe('2027-01-01');
  });
});

describe('wallClockToEpochMs', () => {
  it('round-trips ordinary times in both offsets', () => {
    expect(wallClockToEpochMs('2026-10-08', '00:00')).toBe(utcMs('2026-10-08T06:00:00Z'));
    expect(wallClockToEpochMs('2026-01-15', '23:59')).toBe(utcMs('2026-01-16T06:59:00Z'));
    const epochMs = wallClockToEpochMs('2026-07-04', '13:37');
    expect(dayKey(epochMs)).toBe('2026-07-04');
    expect(timeOfDay(epochMs)).toBe('13:37');
  });

  it('pushes a time skipped by spring-forward an hour later', () => {
    expect(wallClockToEpochMs('2026-03-08', '02:30')).toBe(utcMs('2026-03-08T09:30:00Z'));
    expect(timeOfDay(wallClockToEpochMs('2026-03-08', '02:30'))).toBe('03:30');
  });

  it('resolves the repeated fall-back hour to its first occurrence', () => {
    expect(wallClockToEpochMs('2026-11-01', '01:30')).toBe(utcMs('2026-11-01T07:30:00Z'));
  });
});

describe('calendar arithmetic across DST', () => {
  it('a 23-hour and a 25-hour day are each one day', () => {
    expect(addDays('2026-03-07', 1)).toBe('2026-03-08');
    expect(addDays('2026-03-08', 1)).toBe('2026-03-09');
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02');
    expect(daysBetween('2026-02-28', '2026-03-31')).toBe(31);
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('measures the time to next midnight on short and long days', () => {
    expect(msUntilNextDay(utcMs('2026-03-08T07:00:00Z'))).toBe(23 * 3_600_000);
    expect(msUntilNextDay(utcMs('2026-11-01T06:00:00Z'))).toBe(25 * 3_600_000);
  });

  it('starts weeks on Monday', () => {
    expect(startOfWeek('2026-10-08')).toBe('2026-10-05'); // Thu -> Mon
    expect(startOfWeek('2026-10-11')).toBe('2026-10-05'); // Sun -> Mon
    expect(startOfWeek('2026-10-05')).toBe('2026-10-05');
  });

  it('formats a 12-hour clock in Denver time', () => {
    expect(formatClock(utcMs('2026-10-08T06:05:00Z'))).toBe('12:05a');
    expect(formatClock(utcMs('2026-10-08T19:30:00Z'))).toBe('1:30p');
  });
});
