import type { Account } from '../shared/model';
import { type ProfilePatch, mergeProfile } from '../shared/profile';
import { DEFAULT_TIME_ZONE, addDays, dayKey } from '../shared/time';
import { type Db, type User, PreconditionFailed } from './db';
import { type Clock, mapWithConcurrency, recomputeDayTotal } from './sync';

const MAX_ATTEMPTS = 8;
/** Days of totals re-keyed when the zone changes. Older days keep the keys they were written with. */
export const ZONE_CHANGE_RECOMPUTE_DAYS = 62;
/** Two zones' todays can be up to two dates apart (UTC+14 vs UTC-12), so the window reaches that far past each end. */
const ZONE_SKEW_DAYS = 2;

export function accountOf(user: User): Account {
  const account: Account = { id: user.id, name: user.name, timeZone: user.timeZone ?? DEFAULT_TIME_ZONE };
  for (const field of ['nameUpdatedAt', 'zoneUpdatedAt', 'dailyGoalReps', 'goalUpdatedAt'] as const) if (user[field] !== undefined) account[field] = user[field] as never;
  return account;
}

/**
 * Merges the patch into the stored profile, field by field, conditional on the version read.
 * When the patch's zone is the stored one afterwards (it won now, or it won on an earlier try
 * of the same request), recent day totals are rebuilt in that zone, so a request that died
 * halfway through the rebuild heals when the client retries it.
 */
export async function updateProfile(db: Db, userId: string, patch: ProfilePatch, clock: Clock): Promise<User | null> {
  let updated: User | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS && !updated; attempt++) {
    const stored = await db.getUser(userId);
    if (!stored) return null;
    const merged = mergeProfile(stored, patch);
    if (merged.name === stored.name && merged.nameUpdatedAt === stored.nameUpdatedAt && merged.timeZone === stored.timeZone && merged.zoneUpdatedAt === stored.zoneUpdatedAt && merged.dailyGoalReps === stored.dailyGoalReps && merged.goalUpdatedAt === stored.goalUpdatedAt) {
      updated = stored;
      break;
    }
    try {
      const next = { ...merged, version: (stored.version ?? 0) + 1 };
      await db.putProfile(next, stored.version ?? null);
      updated = next;
    } catch (error) {
      if (!(error instanceof PreconditionFailed)) throw error;
    }
  }
  if (!updated) throw new Error(`gave up writing the profile of ${userId} after ${MAX_ATTEMPTS} conflicting writes`);

  if (patch.timeZone !== undefined && updated.timeZone === patch.timeZone && updated.zoneUpdatedAt === patch.zoneUpdatedAt) {
    await recomputeRecentDays(db, userId, patch.timeZone, clock);
  }
  return updated;
}

async function recomputeRecentDays(db: Db, userId: string, timeZone: string, clock: Clock): Promise<void> {
  const today = dayKey(clock.now(), timeZone);
  const days = Array.from({ length: ZONE_CHANGE_RECOMPUTE_DAYS + 2 * ZONE_SKEW_DAYS }, (_, i) => addDays(today, ZONE_SKEW_DAYS - i));
  console.log(`recomputing ${days.length} day totals for ${userId} in ${timeZone}`);
  await mapWithConcurrency(days, 8, (day) => recomputeDayTotal(db, userId, day, timeZone));
}
