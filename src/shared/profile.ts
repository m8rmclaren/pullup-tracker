import { cleanName } from './model';
import { isValidTimeZone } from './time';

// The editable part of a profile. Each field is its own last-writer-wins register with its
// own clock, so a goal set on the phone and a zone set on the laptop both survive. A field
// with no clock was set at sign-up (or predates clocks) and loses to any edit.

export interface ProfileFields {
  name: string;
  nameUpdatedAt?: number;
  /** Absent means DEFAULT_TIME_ZONE (see time.ts). */
  timeZone?: string;
  zoneUpdatedAt?: number;
  /** Absent until first set; each device then falls back to its own goal. */
  dailyGoalReps?: number;
  goalUpdatedAt?: number;
}

/** POST /api/profile. Every value comes with its clock. */
export interface ProfilePatch {
  name?: string;
  nameUpdatedAt?: number;
  timeZone?: string;
  zoneUpdatedAt?: number;
  dailyGoalReps?: number;
  goalUpdatedAt?: number;
}

export const MIN_DAILY_GOAL_REPS = 1;
export const MAX_DAILY_GOAL_REPS = 10_000;

export const PROFILE_REGISTERS = [
  { value: 'name', clock: 'nameUpdatedAt' },
  { value: 'timeZone', clock: 'zoneUpdatedAt' },
  { value: 'dailyGoalReps', clock: 'goalUpdatedAt' },
] as const;

const isClock = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0;

export function isValidProfilePatch(value: unknown): value is ProfilePatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  for (const register of PROFILE_REGISTERS) {
    if ((fields[register.value] === undefined) !== (fields[register.clock] === undefined)) return false;
    if (fields[register.clock] !== undefined && !isClock(fields[register.clock])) return false;
  }
  if (fields.name !== undefined && cleanName(fields.name) !== fields.name) return false;
  if (fields.timeZone !== undefined && !isValidTimeZone(fields.timeZone)) return false;
  if (fields.dailyGoalReps !== undefined && !(Number.isInteger(fields.dailyGoalReps) && (fields.dailyGoalReps as number) >= MIN_DAILY_GOAL_REPS && (fields.dailyGoalReps as number) <= MAX_DAILY_GOAL_REPS)) return false;
  return true;
}

/** Applies each patched field that is newer than the stored one; a same-tick tie goes to the greater value. */
export function mergeProfile<T extends ProfileFields>(stored: T, patch: ProfilePatch): T {
  const merged: Record<string, unknown> = { ...(stored as Record<string, unknown>) };
  for (const register of PROFILE_REGISTERS) {
    const incomingValue = patch[register.value];
    const incomingClock = patch[register.clock];
    if (incomingValue === undefined || incomingClock === undefined) continue;
    const storedClock = stored[register.clock] ?? 0;
    const storedValue = stored[register.value];
    const isNewer = incomingClock > storedClock || (incomingClock === storedClock && storedValue !== undefined && incomingValue > storedValue);
    if (!isNewer) continue;
    merged[register.value] = incomingValue;
    merged[register.clock] = incomingClock;
  }
  return merged as T;
}
