import { PULL_UP, builtInExercise, builtInVariation, isBuiltInId, isCreatedExerciseId, isCreatedVariationId } from './catalog';
import type { Definition } from './definitions';
import type { ProfileFields } from './profile';

// The data model is a state-based CRDT: a map of entries keyed by id, where each
// entry is a last-writer-wins register and deletes are tombstones. merge() is
// commutative, associative and idempotent, so any two replicas that have seen the
// same set of writes hold identical state, whatever order they saw them in.

export interface Entry {
  id: string;
  /** When the set was done (epoch ms). Decides which day, in the user's zone, it counts toward. */
  doneAt: number;
  /** A built-in slug or a created `x-` id. Absent means pull-up, which normalization enforces. */
  exerciseId?: string;
  /** Built-in slugs or created `v-` ids, unique and sorted. Absent means none. */
  variationIds?: string[];
  /** The count in the exercise's unit (reps, laps, steps). Exactly one of reps and holdSeconds is present. */
  reps?: number;
  holdSeconds?: number;
  /** Added weight in lb (belt, vest, dumbbell). Absent means bodyweight. */
  addedWeightLbs?: number;
  /** When this version was written (epoch ms). The LWW clock. */
  updatedAt: number;
  deleted?: boolean;
}

export const MIN_REPS = 1;
export const MAX_REPS = 100_000;
export const MIN_HOLD_SECONDS = 1;
export const MAX_HOLD_SECONDS = 86_400;
export const MAX_VARIATIONS = 6;
export const MAX_ADDED_WEIGHT_LBS = 300;
/** Smallest weight increment: half a pound, so 2.5 lb plates and kg conversions fit. */
export const ADDED_WEIGHT_STEP_LBS = 0.5;

export const exerciseIdOf = (entry: Entry): string => entry.exerciseId ?? PULL_UP;

const variationKey = (entry: Entry): string => (entry.variationIds ?? []).join(',');

/**
 * Total order over versions of one entry; returns the winner. Each step only runs on a tie in
 * every step before it, and fields old entries lack compare as their defaults, so v1 outcomes
 * are unchanged. The Swift client implements the same chain against merge.json.
 */
export function pickWinner(a: Entry, b: Entry): Entry {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  // Same clock tick on two devices: break the tie deterministically, preferring delete.
  if (!!a.deleted !== !!b.deleted) return a.deleted ? a : b;
  if ((a.reps ?? 0) !== (b.reps ?? 0)) return (a.reps ?? 0) > (b.reps ?? 0) ? a : b;
  if ((a.holdSeconds ?? 0) !== (b.holdSeconds ?? 0)) return (a.holdSeconds ?? 0) > (b.holdSeconds ?? 0) ? a : b;
  if ((a.addedWeightLbs ?? 0) !== (b.addedWeightLbs ?? 0)) return (a.addedWeightLbs ?? 0) > (b.addedWeightLbs ?? 0) ? a : b;
  if (exerciseIdOf(a) !== exerciseIdOf(b)) return exerciseIdOf(a) > exerciseIdOf(b) ? a : b;
  if (variationKey(a) !== variationKey(b)) return variationKey(a) > variationKey(b) ? a : b;
  return a.doneAt >= b.doneAt ? a : b;
}

export function sameVersion(a: Entry, b: Entry): boolean {
  return (
    a.updatedAt === b.updatedAt &&
    !!a.deleted === !!b.deleted &&
    (a.reps ?? 0) === (b.reps ?? 0) &&
    (a.holdSeconds ?? 0) === (b.holdSeconds ?? 0) &&
    (a.addedWeightLbs ?? 0) === (b.addedWeightLbs ?? 0) &&
    exerciseIdOf(a) === exerciseIdOf(b) &&
    variationKey(a) === variationKey(b) &&
    a.doneAt === b.doneAt
  );
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
  const normalized = { id: entry.id, doneAt: entry.doneAt } as Entry;
  if (entry.exerciseId && entry.exerciseId !== PULL_UP) normalized.exerciseId = entry.exerciseId;
  if (entry.variationIds?.length) normalized.variationIds = [...entry.variationIds].sort();
  if (entry.reps !== undefined) normalized.reps = entry.reps;
  if (entry.holdSeconds !== undefined) normalized.holdSeconds = entry.holdSeconds;
  if (entry.addedWeightLbs) normalized.addedWeightLbs = entry.addedWeightLbs;
  normalized.updatedAt = entry.updatedAt;
  if (entry.deleted) normalized.deleted = true;
  return normalized;
}

const isIntegerBetween = (value: unknown, min: number, max: number) => Number.isInteger(value) && (value as number) >= min && (value as number) <= max;

/**
 * Shape checks, plus what the bundled catalog can decide: a built-in exercise must exist and
 * match the entry's measure, and built-in variations are at most one per group. Whether a
 * created exercise's measure matches needs its definition, so the server checks that.
 */
export function isValidEntry(value: unknown): value is Entry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  if (!(typeof fields.id === 'string' && fields.id.length > 0 && fields.id.length <= 64 && /^[A-Za-z0-9_-]+$/.test(fields.id))) return false;
  if (!(Number.isSafeInteger(fields.doneAt) && (fields.doneAt as number) > 0)) return false;
  if (!(Number.isSafeInteger(fields.updatedAt) && (fields.updatedAt as number) > 0)) return false;
  if ((fields.reps === undefined) === (fields.holdSeconds === undefined)) return false;
  if (fields.reps !== undefined && !isIntegerBetween(fields.reps, MIN_REPS, MAX_REPS)) return false;
  if (fields.holdSeconds !== undefined && !isIntegerBetween(fields.holdSeconds, MIN_HOLD_SECONDS, MAX_HOLD_SECONDS)) return false;
  if (fields.addedWeightLbs !== undefined && !isValidAddedWeight(fields.addedWeightLbs)) return false;
  if (fields.deleted !== undefined && typeof fields.deleted !== 'boolean') return false;

  const exerciseId = fields.exerciseId ?? PULL_UP;
  if (typeof exerciseId !== 'string') return false;
  if (!isCreatedExerciseId(exerciseId)) {
    const exercise = isBuiltInId(exerciseId) ? builtInExercise(exerciseId) : undefined;
    if (!exercise || (exercise.measure === 'time') !== (fields.holdSeconds !== undefined)) return false;
  }
  return fields.variationIds === undefined || isValidVariationIds(fields.variationIds);
}

function isValidVariationIds(value: unknown): boolean {
  if (!Array.isArray(value) || value.length > MAX_VARIATIONS || new Set(value).size !== value.length) return false;
  const builtInGroups = new Set<string>();
  for (const id of value) {
    if (typeof id !== 'string') return false;
    if (isCreatedVariationId(id)) continue;
    const variation = isBuiltInId(id) ? builtInVariation(id) : undefined;
    if (!variation || builtInGroups.has(variation.group)) return false;
    builtInGroups.add(variation.group);
  }
  return true;
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

/** The sync protocol this code speaks. A request without it is from a client that would strip fields it doesn't know, so the server turns it away. */
export const PROTOCOL_VERSION = 2;

/** Wire format of POST /api/sync. */
export interface SyncRequest {
  protocolVersion: typeof PROTOCOL_VERSION;
  pushedEntries: Entry[];
  /** Created exercises and variations, new or edited on this device. Merged before the entries, so an entry can log to one pushed alongside it. */
  pushedDefinitions?: Definition[];
  /** The cursor from the previous response; 0 pulls everything. */
  sinceCursor: number;
}

export interface SyncResponse {
  /** Entries written since `sinceCursor` (possibly a few already seen; merging them again is a no-op). */
  entries: Entry[];
  /** Every created definition this account has adopted, plus any the returned entries point at. */
  definitions: Definition[];
  cursor: number;
  account: Account;
}

export const MAX_PUSHED_ENTRIES = 1000;

/** The signed-in profile, as /api/sync, /api/join and /api/profile return it. */
export interface Account extends ProfileFields {
  id: string;
  /** IANA zone the account's days are kept in. The server always sends it; an account persisted by an older client may lack it, which means DEFAULT_TIME_ZONE. */
  timeZone?: string;
}

/**
 * POST /api/join. `name` is required when the code is a friend invite and ignored for a device link.
 * `timeZone` is the device's zone, kept as the new account's zone; without it a new account gets DEFAULT_TIME_ZONE.
 */
export interface JoinRequest {
  code: string;
  name?: string;
  timeZone?: string;
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
