import { type Entry, type SyncResponse, normalizeEntry, pickWinner, sameVersion } from '../shared/model';
import { addDays, dayKey, wallClockToEpochMs } from '../shared/time';
import { type Db, type StoredEntry, PreconditionFailed } from './db';

const MAX_ATTEMPTS = 8;

/**
 * How far the returned cursor trails the clock. A write is stamped with `serverWrittenAt` just
 * before it is sent and the Lambda times out after 10s, so anything stamped more than
 * CURSOR_LAG_MS ago has either committed or failed. Entries newer than the cursor come back
 * again next sync, which is harmless because merging is idempotent.
 */
export const CURSOR_LAG_MS = 30_000;

export interface Clock {
  now: () => number;
}

/** Bounded-concurrency map, so a large push doesn't open hundreds of sockets at once. */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, mapItem: (item: T) => Promise<R>): Promise<R[]> {
  const mapped: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      mapped[i] = await mapItem(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return mapped;
}

const sleepBeforeRetry = (attempt: number) => new Promise((resolve) => setTimeout(resolve, Math.random() * 20 * (attempt + 1)));

/**
 * Writes `incoming` if it beats the stored version. Returns the Denver days whose totals to
 * recompute, even when nothing was written: a retried push may follow a request that wrote
 * the entry and then died before totalling its day. Conditional on the stored `serverWrittenAt`,
 * which strictly increases per entry, so a concurrent writer is always detected and the merge
 * is redone against what it wrote.
 */
async function mergeEntry(db: Db, userId: string, incoming: Entry, stored: StoredEntry | null, clock: Clock): Promise<string[]> {
  const affectedDays = (previous: StoredEntry | null) => (previous ? [dayKey(previous.doneAt), dayKey(incoming.doneAt)] : [dayKey(incoming.doneAt)]);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (stored && sameVersion(pickWinner(stored, incoming), stored)) return affectedDays(stored);
    const next: StoredEntry = { ...normalizeEntry(incoming), serverWrittenAt: Math.max(clock.now(), (stored?.serverWrittenAt ?? 0) + 1) };
    try {
      await db.putEntry(userId, next, stored?.serverWrittenAt ?? null);
      return affectedDays(stored);
    } catch (error) {
      if (!(error instanceof PreconditionFailed)) throw error;
      stored = (await db.getEntries(userId, [incoming.id])).get(incoming.id) ?? null;
      await sleepBeforeRetry(attempt);
    }
  }
  throw new Error(`gave up writing entry ${incoming.id} after ${MAX_ATTEMPTS} conflicting writes`);
}

/**
 * Rebuilds one day's totals from its entries. Every writer runs this after its own entry
 * writes land, and the put is conditional on the version it read, so the last successful
 * recompute always saw every committed entry.
 */
export async function recomputeDayTotal(db: Db, userId: string, day: string): Promise<void> {
  const fromMs = wallClockToEpochMs(day, '00:00');
  const toMs = wallClockToEpochMs(addDays(day, 1), '00:00');
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const stored = await db.getDayTotal(userId, day);
    const liveEntries = (await db.entriesDoneBetween(userId, fromMs, toMs)).filter((entry) => !entry.deleted);
    const dayTotal = {
      day,
      reps: liveEntries.reduce((reps, entry) => reps + entry.reps, 0),
      sets: liveEntries.length,
      bestSetReps: liveEntries.reduce((bestSetReps, entry) => Math.max(bestSetReps, entry.reps), 0),
      version: (stored?.version ?? 0) + 1,
    };
    try {
      await db.putDayTotal(userId, dayTotal, stored?.version ?? null);
      return;
    } catch (error) {
      if (!(error instanceof PreconditionFailed)) throw error;
      await sleepBeforeRetry(attempt);
    }
  }
  throw new Error(`gave up totalling ${day} after ${MAX_ATTEMPTS} conflicting writes`);
}

function withoutServerFields({ serverWrittenAt: _, ...entry }: StoredEntry): Entry {
  return entry;
}

export async function syncEntries(db: Db, userId: string, pushedEntries: Entry[], sinceCursor: number, clock: Clock = { now: Date.now }): Promise<Omit<SyncResponse, 'account'>> {
  // One device can't send two versions of an entry, but a hand-edited import could.
  const incoming = new Map<string, Entry>();
  for (const entry of pushedEntries) {
    const previous = incoming.get(entry.id);
    incoming.set(entry.id, previous ? pickWinner(previous, entry) : entry);
  }

  const storedEntries = await db.getEntries(userId, [...incoming.keys()]);
  const touchedDays = await mapWithConcurrency([...incoming.values()], 16, (entry) => mergeEntry(db, userId, entry, storedEntries.get(entry.id) ?? null, clock));
  await mapWithConcurrency([...new Set(touchedDays.flat())], 8, (day) => recomputeDayTotal(db, userId, day));

  const startMs = clock.now();
  const entries = await db.entriesWrittenAfter(userId, sinceCursor);
  return { entries: entries.map(withoutServerFields), cursor: Math.max(sinceCursor, startMs - CURSOR_LAG_MS) };
}
