import { describe, expect, it } from 'vitest';
import { computeStats, dailySeries, dailyTotals, heaviestSet, trailingAverage, usualReps } from '../src/shared/stats';
import { wallClockToEpochMs } from '../src/shared/time';
import { type StatsFixtureCase, expectMatches, instantMs, loadFixture, toEntries } from './fixtures';

const fixture = loadFixture<{ cases: StatsFixtureCase[] }>('stats.json');

describe('stats.json', () => {
  describe.each(fixture.cases)('$name', ({ entries: rows, goalReps, dayTotals: storedDayTotals, checks }) => {
    const entries = toEntries(rows);

    it.each(checks)('at $now', ({ now, stats, dayTotals: expectedDayTotals, usualReps: expectedUsualReps, heaviestSet: expectedHeaviestSet }) => {
      const nowMs = instantMs(now);
      if (stats) expectMatches(computeStats(entries, nowMs, goalReps), stats);
      if (expectedDayTotals) {
        const totals = dailyTotals(entries);
        for (const [day, expected] of Object.entries(expectedDayTotals)) expect(totals.get(day)).toMatchObject(expected);
      }
      if (expectedUsualReps !== undefined) expect(usualReps(entries, nowMs)).toBe(expectedUsualReps);
      if (expectedHeaviestSet !== undefined) expect(heaviestSet(entries, nowMs)).toEqual(expectedHeaviestSet);
    });

    if (storedDayTotals) {
      it('has the same per-day reps and sets as the stored day totals', () => {
        const totals = dailyTotals(entries);
        expect(Object.fromEntries([...totals.values()].map(({ day, reps, sets }) => [day, { reps, sets }]))).toEqual(
          Object.fromEntries(Object.entries(storedDayTotals).filter(([, total]) => total.sets > 0).map(([day, { reps, sets }]) => [day, { reps, sets }])),
        );
      });
    }
  });
});

describe('dailySeries / trailingAverage', () => {
  const set = (day: string, hhmm: string, reps: number) => ({ id: `${day}${hhmm}`, doneAt: wallClockToEpochMs(day, hhmm), reps, updatedAt: 1 });

  it('zero-fills missing days', () => {
    const totals = dailyTotals([set('2026-10-06', '09:00', 10)]);
    expect(dailySeries(totals, '2026-10-08', 3).map((dayTotal) => dayTotal.reps)).toEqual([10, 0, 0]);
  });

  it('averages only over days since the first set', () => {
    const totals = dailyTotals([set('2026-10-07', '09:00', 30), set('2026-10-08', '09:00', 40)]);
    expect(trailingAverage(totals, ['2026-10-06', '2026-10-07', '2026-10-08'], 7, '2026-10-07')).toEqual([null, 30, 35]);
  });
});
