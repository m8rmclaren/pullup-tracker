import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import type { Entry } from '../src/shared/model';

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
  /** The server's stored day totals for this history, where the case pins them. */
  dayTotals?: Record<string, { reps: number; sets: number; bestSetReps: number }>;
  checks: {
    now: string;
    stats?: Record<string, unknown>;
    dayTotals?: Record<string, { reps: number; sets: number }>;
    usualReps?: number | null;
    heaviestSet?: Record<string, unknown> | null;
  }[];
}
