// The data model is a state-based CRDT: a map of entries keyed by id, where each
// entry is a last-writer-wins register and deletes are tombstones. merge() is
// commutative, associative and idempotent, so any two replicas that have seen the
// same set of writes hold identical state, whatever order they saw them in.

export interface Entry {
  id: string;
  /** When the set was done (epoch ms). Decides which Denver day it counts toward. */
  ts: number;
  reps: number;
  /** Added weight in lb (belt, vest, dumbbell). Absent means bodyweight. */
  lbs?: number;
  /** When this version was written (epoch ms). The LWW clock. */
  updatedAt: number;
  deleted?: boolean;
}

export const MIN_REPS = 1;
export const MAX_REPS = 100;
export const MAX_LBS = 300;
/** Smallest weight increment: half a pound, so 2.5 lb plates and kg conversions fit. */
export const LBS_STEP = 0.5;

/** Total order over versions of one entry; returns the winner. */
export function pickWinner(a: Entry, b: Entry): Entry {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  // Same clock tick on two devices: break the tie deterministically, preferring delete.
  if (!!a.deleted !== !!b.deleted) return a.deleted ? a : b;
  if (a.reps !== b.reps) return a.reps > b.reps ? a : b;
  if ((a.lbs ?? 0) !== (b.lbs ?? 0)) return (a.lbs ?? 0) > (b.lbs ?? 0) ? a : b;
  return a.ts >= b.ts ? a : b;
}

export function sameVersion(a: Entry, b: Entry): boolean {
  return a.updatedAt === b.updatedAt && !!a.deleted === !!b.deleted && a.reps === b.reps && (a.lbs ?? 0) === (b.lbs ?? 0) && a.ts === b.ts;
}

/** Merges `incoming` into `into` in place. Returns the ids whose stored version changed. */
export function mergeInto(into: Map<string, Entry>, incoming: Iterable<Entry>): string[] {
  const changed: string[] = [];
  for (const e of incoming) {
    const cur = into.get(e.id);
    if (!cur) {
      into.set(e.id, normalize(e));
      changed.push(e.id);
      continue;
    }
    const win = pickWinner(cur, e);
    if (!sameVersion(win, cur)) {
      into.set(e.id, normalize(win));
      changed.push(e.id);
    }
  }
  return changed;
}

export function mergeLists(base: Entry[], incoming: Entry[]): { entries: Entry[]; changed: boolean } {
  const map = new Map(base.map((e) => [e.id, e]));
  const changed = mergeInto(map, incoming).length > 0;
  return { entries: [...map.values()].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1)), changed };
}

function normalize(e: Entry): Entry {
  const out: Entry = { id: e.id, ts: e.ts, reps: e.reps, updatedAt: e.updatedAt };
  if (e.lbs) out.lbs = e.lbs;
  if (e.deleted) out.deleted = true;
  return out;
}

export function isValidEntry(x: unknown): x is Entry {
  if (!x || typeof x !== 'object') return false;
  const e = x as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    e.id.length > 0 &&
    e.id.length <= 64 &&
    /^[A-Za-z0-9_-]+$/.test(e.id) &&
    Number.isSafeInteger(e.ts) &&
    (e.ts as number) > 0 &&
    Number.isSafeInteger(e.updatedAt) &&
    (e.updatedAt as number) > 0 &&
    Number.isInteger(e.reps) &&
    (e.reps as number) >= MIN_REPS &&
    (e.reps as number) <= MAX_REPS &&
    (e.lbs === undefined || isValidLbs(e.lbs)) &&
    (e.deleted === undefined || typeof e.deleted === 'boolean')
  );
}

function isValidLbs(x: unknown): boolean {
  return typeof x === 'number' && x > 0 && x <= MAX_LBS && Number.isInteger(x / LBS_STEP);
}

/** Rounds to the nearest step and clamps; 0 means bodyweight. */
export function clampLbs(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(MAX_LBS, Math.max(0, Math.round(n / LBS_STEP) * LBS_STEP));
}

/** "+25 lb", or "" for bodyweight. */
export function formatLbs(lbs: number | undefined): string {
  return lbs ? `+${lbs} lb` : '';
}

/** Wire format of POST /api/sync. */
export interface SyncRequest {
  push: Entry[];
  /** month key -> ETag the client already holds; unchanged months are not resent. */
  have: Record<string, string>;
}

export interface SyncResponse {
  months: Record<string, { etag: string; entries: Entry[] }>;
}

export const MAX_PUSH = 1000;

/** S3 object body for one Denver calendar month. */
export interface MonthDoc {
  v: 1;
  entries: Entry[];
}
