import { addDays, dayKey } from '../shared/time';
import type { Db } from './db';
import type { Clock } from './sync';

/** Markers are written for sign-up + 30 days; looking this far back catches every day a run missed. */
const LOOKBACK_DAYS = 30;
/** Stops starting new accounts after this, well inside the Lambda's 10s; what's left waits for the next run. */
const TIME_BUDGET_MS = 6_000;

export interface SweepResult {
  deleted: number;
  kept: number;
  /** Markers left for the next run because the time budget ran out. */
  remaining: number;
}

/**
 * Deletes accounts that are still empty 30 days after sign-up: no entries, no friends, no
 * challenges, no adopted exercises. Every account it looks at loses its marker, so a kept one
 * is never looked at again. Accounts from before passkeys have no marker and are never swept.
 */
export async function sweepEmptyAccounts(db: Db, clock: Clock): Promise<SweepResult> {
  const startMs = clock.now();
  const today = dayKey(startMs, 'UTC');
  const result: SweepResult = { deleted: 0, kept: 0, remaining: 0 };
  for (let daysBack = LOOKBACK_DAYS; daysBack >= 0; daysBack--) {
    const day = addDays(today, -daysBack);
    for (const userId of await db.sweepMarkersFor(day)) {
      if (clock.now() - startMs > TIME_BUDGET_MS) {
        result.remaining++;
        continue;
      }
      if (await db.hasContent(userId)) result.kept++;
      else {
        await db.deleteAccount(userId);
        result.deleted++;
      }
      await db.deleteSweepMarker(day, userId);
    }
  }
  return result;
}
