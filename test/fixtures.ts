import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import type { ExerciseDefinition } from '../src/shared/definitions';
import type { Entry } from '../src/shared/model';
import type { DayTotalRecord } from '../src/shared/stats';

export function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as T;
}

/** Fixture instants are ISO 8601 strings, so they read in local time; the wire format is epoch ms. */
export const instantMs = (value: string | number): number => (typeof value === 'string' ? Date.parse(value) : value);

export interface FixtureEntry extends Omit<Entry, 'doneAt'> {
  doneAt: string | number;
}

export const toEntries = (rows: FixtureEntry[]): Entry[] => rows.map((row) => ({ ...row, doneAt: instantMs(row.doneAt) }) as Entry);

/** Deep subset match where expected fractions compare to 9 places, as a Swift port would. */
export function expectMatches(actual: unknown, expected: unknown): void {
  expect(actual).toMatchObject(withCloseNumbers(expected) as object);
}

function withCloseNumbers(value: unknown): unknown {
  if (typeof value === 'number' && !Number.isInteger(value)) return expect.closeTo(value, 9);
  if (Array.isArray(value)) return value.map(withCloseNumbers);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, withCloseNumbers(inner)]));
  return value;
}

export interface StatsFixtureCase {
  name: string;
  timeZone: string;
  goalReps: number;
  entries: FixtureEntry[];
  /** Created exercises the entries log to, for their units. */
  definitions?: ExerciseDefinition[];
  /** The server's stored day totals for this history as v1 wrote them, where the case pins them. */
  dayTotals?: Record<string, { reps: number; sets: number; bestSetReps: number }>;
  /** Full day totals (computeDayTotal) for the days the case pins. */
  dayTotalRecords?: Record<string, DayTotalRecord>;
  checks: {
    now: string;
    stats?: Record<string, unknown>;
    dayTotals?: Record<string, { reps: number; sets: number }>;
    usualReps?: number | null;
    heaviestSet?: Record<string, unknown> | null;
    /** Per exercise, in its own unit: exerciseDailyTotals, statsFromTotals over them, bestSet and heaviestSet. */
    exercises?: Record<string, { dayTotals?: Record<string, { reps: number; sets: number }>; stats?: Record<string, unknown>; bestSet?: { amount: number; day: string } | null; heaviestSet?: Record<string, unknown> | null }>;
  }[];
}
