// The data model is a state-based CRDT: a map of entries keyed by id, where each
// entry is a last-writer-wins register and deletes are tombstones. merge() is
// commutative, associative and idempotent, so any two replicas that have seen the
// same set of writes hold identical state, whatever order they saw them in.

export interface Entry {
  id: string;
  /** When the set was done (epoch ms). Decides which Denver day it counts toward. */
  doneAt: number;
  reps: number;
  /** Added weight in lb (belt, vest, dumbbell). Absent means bodyweight. */
  addedWeightLbs?: number;
  /** When this version was written (epoch ms). The LWW clock. */
  updatedAt: number;
  deleted?: boolean;
}

export const MIN_REPS = 1;
export const MAX_REPS = 100;
export const MAX_ADDED_WEIGHT_LBS = 300;
/** Smallest weight increment: half a pound, so 2.5 lb plates and kg conversions fit. */
export const ADDED_WEIGHT_STEP_LBS = 0.5;

/** Total order over versions of one entry; returns the winner. */
export function pickWinner(a: Entry, b: Entry): Entry {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  // Same clock tick on two devices: break the tie deterministically, preferring delete.
  if (!!a.deleted !== !!b.deleted) return a.deleted ? a : b;
  if (a.reps !== b.reps) return a.reps > b.reps ? a : b;
  if ((a.addedWeightLbs ?? 0) !== (b.addedWeightLbs ?? 0)) return (a.addedWeightLbs ?? 0) > (b.addedWeightLbs ?? 0) ? a : b;
  return a.doneAt >= b.doneAt ? a : b;
}

export function sameVersion(a: Entry, b: Entry): boolean {
  return a.updatedAt === b.updatedAt && !!a.deleted === !!b.deleted && a.reps === b.reps && (a.addedWeightLbs ?? 0) === (b.addedWeightLbs ?? 0) && a.doneAt === b.doneAt;
}

/** Merges `incoming` into `into` in place. Returns the ids whose stored version changed. */
export function mergeInto(into: Map<string, Entry>, incoming: Iterable<Entry>): string[] {
  const changed: string[] = [];
  for (const entry of incoming) {
    const stored = into.get(entry.id);
    if (!stored) {
      into.set(entry.id, normalizeEntry(entry));
      changed.push(entry.id);
      continue;
    }
    const winner = pickWinner(stored, entry);
    if (!sameVersion(winner, stored)) {
      into.set(entry.id, normalizeEntry(winner));
      changed.push(entry.id);
    }
  }
  return changed;
}

export function mergeLists(base: Entry[], incoming: Entry[]): { entries: Entry[]; changed: boolean } {
  const entriesById = new Map(base.map((entry) => [entry.id, entry]));
  const changed = mergeInto(entriesById, incoming).length > 0;
  return { entries: [...entriesById.values()].sort((a, b) => a.doneAt - b.doneAt || (a.id < b.id ? -1 : 1)), changed };
}

/** Drops unknown and default-valued fields so stored and compared versions have one shape. */
export function normalizeEntry(entry: Entry): Entry {
  const normalized: Entry = { id: entry.id, doneAt: entry.doneAt, reps: entry.reps, updatedAt: entry.updatedAt };
  if (entry.addedWeightLbs) normalized.addedWeightLbs = entry.addedWeightLbs;
  if (entry.deleted) normalized.deleted = true;
  return normalized;
}

export function isValidEntry(value: unknown): value is Entry {
  if (!value || typeof value !== 'object') return false;
  const fields = value as Record<string, unknown>;
  return (
    typeof fields.id === 'string' &&
    fields.id.length > 0 &&
    fields.id.length <= 64 &&
    /^[A-Za-z0-9_-]+$/.test(fields.id) &&
    Number.isSafeInteger(fields.doneAt) &&
    (fields.doneAt as number) > 0 &&
    Number.isSafeInteger(fields.updatedAt) &&
    (fields.updatedAt as number) > 0 &&
    Number.isInteger(fields.reps) &&
    (fields.reps as number) >= MIN_REPS &&
    (fields.reps as number) <= MAX_REPS &&
    (fields.addedWeightLbs === undefined || isValidAddedWeight(fields.addedWeightLbs)) &&
    (fields.deleted === undefined || typeof fields.deleted === 'boolean')
  );
}

function isValidAddedWeight(value: unknown): boolean {
  return typeof value === 'number' && value > 0 && value <= MAX_ADDED_WEIGHT_LBS && Number.isInteger(value / ADDED_WEIGHT_STEP_LBS);
}

/** Rounds to the nearest step and clamps; 0 means bodyweight. */
export function clampAddedWeight(addedWeightLbs: number): number {
  if (!Number.isFinite(addedWeightLbs)) return 0;
  return Math.min(MAX_ADDED_WEIGHT_LBS, Math.max(0, Math.round(addedWeightLbs / ADDED_WEIGHT_STEP_LBS) * ADDED_WEIGHT_STEP_LBS));
}

/** "+25 lb", or "" for bodyweight. */
export function formatAddedWeight(addedWeightLbs: number | undefined): string {
  return addedWeightLbs ? `+${addedWeightLbs} lb` : '';
}

/** Wire format of POST /api/sync. */
export interface SyncRequest {
  pushedEntries: Entry[];
  /** The cursor from the previous response; 0 pulls everything. */
  sinceCursor: number;
}

export interface SyncResponse {
  /** Entries written since `sinceCursor` (possibly a few already seen; merging them again is a no-op). */
  entries: Entry[];
  cursor: number;
  account: Account;
}

export const MAX_PUSHED_ENTRIES = 1000;

export interface Account {
  id: string;
  name: string;
}

/** POST /api/join. `name` is required when the code is a friend invite and ignored for a device link. */
export interface JoinRequest {
  code: string;
  name?: string;
}

export interface JoinResponse {
  token: string;
  account: Account;
}

export type InviteKind = 'friend' | 'device';

/** POST /api/invite. */
export interface InviteRequest {
  kind: InviteKind;
}

export interface InviteResponse {
  code: string;
  expiresAt: number;
}

export const MAX_NAME_LENGTH = 24;

/** Trims and collapses whitespace; null if nothing printable is left or it is too long. */
export function cleanName(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const cleaned = input.replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim();
  return cleaned.length >= 1 && [...cleaned].length <= MAX_NAME_LENGTH ? cleaned : null;
}
