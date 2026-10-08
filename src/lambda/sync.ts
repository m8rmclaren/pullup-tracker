import { type Entry, type SyncResponse, normalize, pickWinner, sameVersion } from '../shared/model';
import { addDays, dayKey, wallToEpoch } from '../shared/time';
import { type Db, type StoredEntry, PreconditionFailed } from './db';

const MAX_ATTEMPTS = 8;

/**
 * How far the returned cursor trails the clock. A write is stamped with `srv` just before
 * it is sent and the Lambda times out after 10s, so anything stamped more than LAG_MS ago
 * has either committed or failed. Entries newer than the cursor come back again next sync,
 * which is harmless because merging is idempotent.
 */
export const LAG_MS = 30_000;

export interface Clock {
  now: () => number;
}

/** Bounded-concurrency map, so a large push doesn't open hundreds of sockets at once. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const backoff = (attempt: number) => new Promise((r) => setTimeout(r, Math.random() * 20 * (attempt + 1)));

/**
 * Writes `incoming` if it beats the stored version. Returns the Denver days whose totals to
 * recompute, even when nothing was written: a retried push may follow a request that wrote
 * the entry and then died before totalling its day. Conditional on the stored `srv`, which
 * strictly increases per entry, so a concurrent writer is always detected and the merge is
 * redone against what it wrote.
 */
async function mergeEntry(db: Db, uid: string, incoming: Entry, cur: StoredEntry | null, clock: Clock): Promise<string[]> {
  const days = (stored: StoredEntry | null) => (stored ? [dayKey(stored.ts), dayKey(incoming.ts)] : [dayKey(incoming.ts)]);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (cur && sameVersion(pickWinner(cur, incoming), cur)) return days(cur);
    const next: StoredEntry = { ...normalize(incoming), srv: Math.max(clock.now(), (cur?.srv ?? 0) + 1) };
    try {
      await db.putEntry(uid, next, cur?.srv ?? null);
      return days(cur);
    } catch (err) {
      if (!(err instanceof PreconditionFailed)) throw err;
      cur = (await db.getEntries(uid, [incoming.id])).get(incoming.id) ?? null;
      await backoff(attempt);
    }
  }
  throw new Error(`gave up writing entry ${incoming.id} after ${MAX_ATTEMPTS} conflicting writes`);
}

/**
 * Rebuilds one day's totals from its entries. Every writer runs this after its own entry
 * writes land, and the put is conditional on the version it read, so the last successful
 * recompute always saw every committed entry.
 */
export async function recomputeDay(db: Db, uid: string, day: string): Promise<void> {
  const from = wallToEpoch(day, '00:00');
  const to = wallToEpoch(addDays(day, 1), '00:00');
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const cur = await db.getDay(uid, day);
    const live = (await db.entriesBetween(uid, from, to)).filter((e) => !e.deleted);
    const total = {
      day,
      reps: live.reduce((n, e) => n + e.reps, 0),
      sets: live.length,
      best: live.reduce((n, e) => Math.max(n, e.reps), 0),
      ver: (cur?.ver ?? 0) + 1,
    };
    try {
      await db.putDay(uid, total, cur?.ver ?? null);
      return;
    } catch (err) {
      if (!(err instanceof PreconditionFailed)) throw err;
      await backoff(attempt);
    }
  }
  throw new Error(`gave up totalling ${day} after ${MAX_ATTEMPTS} conflicting writes`);
}

function strip({ srv: _, ...e }: StoredEntry): Entry {
  return e;
}

export async function handleSync(db: Db, uid: string, push: Entry[], since: number, clock: Clock = { now: Date.now }): Promise<Omit<SyncResponse, 'me'>> {
  // One device can't send two versions of an entry, but a hand-edited import could.
  const incoming = new Map<string, Entry>();
  for (const e of push) {
    const prev = incoming.get(e.id);
    incoming.set(e.id, prev ? pickWinner(prev, e) : e);
  }

  const current = await db.getEntries(uid, [...incoming.keys()]);
  const touched = await mapLimit([...incoming.values()], 16, (e) => mergeEntry(db, uid, e, current.get(e.id) ?? null, clock));
  await mapLimit([...new Set(touched.flat())], 8, (day) => recomputeDay(db, uid, day));

  const start = clock.now();
  const entries = await db.entriesSince(uid, since);
  return { entries: entries.map(strip), cursor: Math.max(since, start - LAG_MS) };
}
