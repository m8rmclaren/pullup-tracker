import { describe, expect, it } from 'vitest';
import type { Entry } from '../src/shared/model';
import { computeStats, dailySeries, dailyTotals, heaviestSet, trailingAverage, usualReps } from '../src/shared/stats';
import { wallClockToEpochMs } from '../src/shared/time';

let entryCount = 0;
const set = (day: string, hhmm: string, reps: number, extra: Partial<Entry> = {}): Entry => ({
  id: `e${++entryCount}`,
  doneAt: wallClockToEpochMs(day, hhmm),
  reps,
  updatedAt: 1,
  ...extra,
});
const NOW = wallClockToEpochMs('2026-10-08', '15:00'); // Thursday

describe('dailyTotals', () => {
  it('sums reps and counts sets per Denver day, ignoring tombstones', () => {
    const totals = dailyTotals([
      set('2026-10-08', '07:00', 5),
      set('2026-10-08', '12:00', 6),
      set('2026-10-08', '13:00', 8, { deleted: true }),
      set('2026-10-07', '23:59', 4),
      set('2026-10-08', '00:00', 3),
    ]);
    expect(totals.get('2026-10-08')).toEqual({ day: '2026-10-08', reps: 14, sets: 3 });
    expect(totals.get('2026-10-07')).toEqual({ day: '2026-10-07', reps: 4, sets: 1 });
  });

  it('counts a set at 11:30pm on the night clocks fall back toward that day', () => {
    const totals = dailyTotals([set('2026-10-31', '23:30', 7), set('2026-11-01', '01:30', 2)]);
    expect(totals.get('2026-10-31')?.reps).toBe(7);
    expect(totals.get('2026-11-01')?.reps).toBe(2);
  });
});

describe('dailySeries / trailingAverage', () => {
  it('zero-fills missing days', () => {
    const totals = dailyTotals([set('2026-10-06', '09:00', 10)]);
    expect(dailySeries(totals, '2026-10-08', 3).map((dayTotal) => dayTotal.reps)).toEqual([10, 0, 0]);
  });

  it('averages only over days since the first set', () => {
    const totals = dailyTotals([set('2026-10-07', '09:00', 30), set('2026-10-08', '09:00', 40)]);
    const days = ['2026-10-06', '2026-10-07', '2026-10-08'];
    expect(trailingAverage(totals, days, 7, '2026-10-07')).toEqual([null, 30, 35]);
  });
});

describe('computeStats', () => {
  it('computes streaks that survive an empty today but break on a gap', () => {
    const entries = [
      set('2026-10-04', '09:00', 40),
      // 10-05 missing
      set('2026-10-06', '09:00', 36),
      set('2026-10-07', '09:00', 20),
    ];
    const stats = computeStats(entries, NOW, 35);
    expect(stats.streak).toBe(2); // 06, 07 — today has nothing yet, so it doesn't break
    expect(stats.goalStreak).toBe(0); // 07 missed the goal
    const statsWithToday = computeStats([...entries, set('2026-10-08', '08:00', 5)], NOW, 35);
    expect(statsWithToday.streak).toBe(3);
  });

  it('averages completed days only and not before the first set', () => {
    const entries = [set('2026-10-05', '09:00', 30), set('2026-10-07', '09:00', 36), set('2026-10-08', '09:00', 3)];
    const stats = computeStats(entries, NOW, 35);
    // 05, 06, 07 => (30 + 0 + 36) / 3; today's partial 3 excluded
    expect(stats.avgDailyReps7Days).toBeCloseTo(22);
    expect(stats.avgDailyReps30Days).toBeCloseTo(22);
    expect(stats.today).toEqual({ day: '2026-10-08', reps: 3, sets: 1 });
  });

  it('finds the best day, lifetime totals and week-over-week to date', () => {
    const entries = [
      set('2026-09-29', '09:00', 20), // last Tue
      set('2026-10-01', '09:00', 50), // last Thu
      set('2026-10-03', '09:00', 99), // last Sat — after "to date" cutoff
      set('2026-10-06', '09:00', 25), // this Tue
      set('2026-10-08', '09:00', 10), // this Thu
    ];
    const stats = computeStats(entries, NOW, 35);
    expect(stats.bestDay?.day).toBe('2026-10-03');
    expect(stats.lifetimeReps).toBe(204);
    expect(stats.lifetimeSets).toBe(5);
    expect(stats.weekToDate).toBe(35);
    expect(stats.lastWeekToDate).toBe(70);
    expect(stats.avgSetReps30Days).toBeCloseTo(204 / 5);
    expect(stats.goalDaysLast30).toBe(2);
  });

  it('handles an empty history', () => {
    const stats = computeStats([], NOW, 35);
    expect(stats).toMatchObject({ streak: 0, avgDailyReps7Days: null, bestDay: null, lifetimeReps: 0, firstDay: null });
  });

  it('picks the most common recent rep count', () => {
    expect(usualReps([set('2026-10-08', '09:00', 5), set('2026-10-08', '10:00', 6), set('2026-10-07', '10:00', 6)], NOW)).toBe(6);
    expect(usualReps([], NOW)).toBeNull();
  });
});

describe('heaviestSet', () => {
  it('is null with only bodyweight sets', () => {
    expect(heaviestSet([set('2026-10-08', '09:00', 8)], NOW)).toBeNull();
  });

  it('picks the most weight, then most reps, ignoring tombstones', () => {
    const entries = [
      set('2026-10-01', '09:00', 5, { addedWeightLbs: 25 }),
      set('2026-10-03', '09:00', 2, { addedWeightLbs: 45 }),
      set('2026-10-05', '09:00', 3, { addedWeightLbs: 45 }),
      set('2026-10-06', '09:00', 1, { addedWeightLbs: 70, deleted: true }),
    ];
    expect(heaviestSet(entries, NOW)).toEqual({ addedWeightLbs: 45, reps: 3, day: '2026-10-05' });
  });
});
