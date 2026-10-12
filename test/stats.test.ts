import { describe, expect, it } from 'vitest';
import type { Entry } from '../src/shared/model';
import { type ExerciseDayTotal, type UnitLookup, builtInUnit, computeDayTotal, computeStats, dailySeries, dailyTotals, exerciseDayTotals, heaviestSet, trailingAverage, usualReps } from '../src/shared/stats';
import { dayKey, wallClockToEpochMs } from '../src/shared/time';
import { type StatsFixtureCase, expectMatches, instantMs, loadFixture, toEntries } from './fixtures';

interface LegacyDayTotalCase {
  name: string;
  dayTotal: Parameters<typeof exerciseDayTotals>[0];
  byExercise: Record<string, ExerciseDayTotal>;
}

const fixture = loadFixture<{ cases: StatsFixtureCase[]; legacyDayTotals: LegacyDayTotalCase[] }>('stats.json');

function entriesByDay(entries: Entry[], timeZone: string): Map<string, Entry[]> {
  const byDay = new Map<string, Entry[]>();
  for (const entry of entries) byDay.set(dayKey(entry.doneAt, timeZone), [...(byDay.get(dayKey(entry.doneAt, timeZone)) ?? []), entry]);
  return byDay;
}

describe('stats.json', () => {
  describe.each(fixture.cases)('$name', ({ entries: rows, timeZone, goalReps, definitions = [], dayTotals: storedDayTotals, dayTotalRecords, checks }) => {
    const entries = toEntries(rows);
    const unitOf: UnitLookup = (exerciseId) => builtInUnit(exerciseId) ?? definitions.find((definition) => definition.id === exerciseId)?.unit;

    it.each(checks)('at $now', ({ now, stats, dayTotals: expectedDayTotals, usualReps: expectedUsualReps, heaviestSet: expectedHeaviestSet }) => {
      const nowMs = instantMs(now);
      if (stats) expectMatches(computeStats(entries, nowMs, goalReps, timeZone, unitOf), stats);
      if (expectedDayTotals) {
        const totals = dailyTotals(entries, timeZone, unitOf);
        for (const [day, expected] of Object.entries(expectedDayTotals)) expect(totals.get(day)).toMatchObject(expected);
      }
      if (expectedUsualReps !== undefined) expect(usualReps(entries, nowMs, timeZone)).toBe(expectedUsualReps);
      if (expectedHeaviestSet !== undefined) expect(heaviestSet(entries, nowMs, timeZone)).toEqual(expectedHeaviestSet);
    });

    if (dayTotalRecords) {
      it('computes the full day totals the server stores', () => {
        const byDay = entriesByDay(entries, timeZone);
        for (const [day, expected] of Object.entries(dayTotalRecords)) expect(computeDayTotal(day, byDay.get(day) ?? [], unitOf)).toEqual(expected);
      });
    }

    if (storedDayTotals) {
      it('reads every v1 stored total exactly as a v2 recompute of the same day', () => {
        for (const [day, dayEntries] of entriesByDay(entries, timeZone)) {
          const recomputed = computeDayTotal(day, dayEntries, unitOf);
          const storedInV1 = storedDayTotals[day]!;
          expect({ reps: recomputed.reps, sets: recomputed.sets, bestSetReps: recomputed.bestSetReps }).toEqual(storedInV1);
          const withoutWeight = Object.fromEntries(Object.entries(recomputed.byExercise).map(([exerciseId, { bestAddedWeightLbs: _, ...total }]) => [exerciseId, total]));
          expect(exerciseDayTotals(storedInV1)).toEqual(withoutWeight);
        }
      });

      it('has the same per-day reps and sets as the stored day totals', () => {
        const totals = dailyTotals(entries, timeZone);
        expect(Object.fromEntries([...totals.values()].map(({ day, reps, sets }) => [day, { reps, sets }]))).toEqual(
          Object.fromEntries(Object.entries(storedDayTotals).filter(([, total]) => total.sets > 0).map(([day, { reps, sets }]) => [day, { reps, sets }])),
        );
      });
    }
  });
});

describe('stats.json legacyDayTotals', () => {
  it.each(fixture.legacyDayTotals)('exerciseDayTotals: $name', ({ dayTotal, byExercise }) => {
    expect(exerciseDayTotals(dayTotal)).toEqual(byExercise);
  });
});

describe('dailySeries / trailingAverage', () => {
  const set = (day: string, hhmm: string, reps: number) => ({ id: `${day}${hhmm}`, doneAt: wallClockToEpochMs(day, hhmm, 'America/Denver'), reps, updatedAt: 1 });

  it('zero-fills missing days', () => {
    const totals = dailyTotals([set('2026-10-06', '09:00', 10)], 'America/Denver');
    expect(dailySeries(totals, '2026-10-08', 3).map((dayTotal) => dayTotal.reps)).toEqual([10, 0, 0]);
  });

  it('averages only over days since the first set', () => {
    const totals = dailyTotals([set('2026-10-07', '09:00', 30), set('2026-10-08', '09:00', 40)], 'America/Denver');
    expect(trailingAverage(totals, ['2026-10-06', '2026-10-07', '2026-10-08'], 7, '2026-10-07')).toEqual([null, 30, 35]);
  });
});
