import { isCreatedExerciseId } from '../shared/catalog';
import type { BoardDay, BoardMember } from '../shared/boards';
import type { Definition } from '../shared/definitions';
import type { ExerciseSummary, LeaderboardResponse, ProfileViewResponse } from '../shared/model';
import { exerciseDayTotals } from '../shared/stats';
import { DEFAULT_TIME_ZONE, addDays, dayKey, daysBetween } from '../shared/time';
import type { Db, StoredDayTotal, User } from './db';
import { RequestError } from './errors';
import { MAX_FRIENDS } from './friends';
import { type Clock, mapWithConcurrency } from './sync';

/** A board covers at most this many days, so it stays one bounded read per person. */
export const MAX_BOARD_DAYS = 62;
export const PROFILE_RECENT_DAYS = 90;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function boardDay({ version: _, ...dayTotal }: StoredDayTotal): BoardDay {
  return dayTotal;
}

/** Validates a requested window: real day keys, in order, at most MAX_BOARD_DAYS long. */
export function parseWindow(body: Record<string, unknown>): { fromDay: string; toDay: string } {
  const { fromDay, toDay } = body;
  if (typeof fromDay !== 'string' || typeof toDay !== 'string' || !DAY_PATTERN.test(fromDay) || !DAY_PATTERN.test(toDay) || addDays(fromDay, 0) !== fromDay || addDays(toDay, 0) !== toDay) {
    throw new RequestError(400, 'fromDay and toDay must be YYYY-MM-DD days.');
  }
  const dayCount = daysBetween(fromDay, toDay) + 1;
  if (dayCount < 1 || dayCount > MAX_BOARD_DAYS) throw new RequestError(400, `A board covers 1 to ${MAX_BOARD_DAYS} days.`);
  return { fromDay, toDay };
}

export function boardMember(user: User, days: BoardDay[]): BoardMember {
  const member: BoardMember = { id: user.id, name: user.name, timeZone: user.timeZone ?? DEFAULT_TIME_ZONE, days };
  if (user.dailyGoalReps !== undefined) member.dailyGoalReps = user.dailyGoalReps;
  return member;
}

/** The created exercises some day totals name, so a client can show friends' invented exercises. */
export async function definitionsNamedBy(db: Db, days: BoardDay[]): Promise<Definition[]> {
  const exerciseIds = new Set<string>();
  for (const day of days) for (const exerciseId of Object.keys(exerciseDayTotals(day))) if (isCreatedExerciseId(exerciseId)) exerciseIds.add(exerciseId);
  if (!exerciseIds.size) return [];
  const definitions = await db.getDefinitions([...exerciseIds].map((exerciseId) => ({ exerciseId })));
  return [...definitions.values()].map(({ version: _, ...definition }) => definition as Definition);
}

/** You and your friends, each with their day totals in the window. The client ranks. */
export async function leaderboard(db: Db, userId: string, body: Record<string, unknown>): Promise<LeaderboardResponse> {
  const { fromDay, toDay } = parseWindow(body);
  const userIds = [userId, ...(await db.friendIds(userId)).slice(0, MAX_FRIENDS)];
  const users = await db.getUsers(userIds);
  const members = await mapWithConcurrency([...users.values()], 16, async (user) => boardMember(user, (await db.dayTotalsBetween(user.id, fromDay, toDay)).map(boardDay)));
  return { users: members, definitions: await definitionsNamedBy(db, members.flatMap((member) => member.days)) };
}

function summarizeExercises(days: BoardDay[]): ExerciseSummary[] {
  const summaries = new Map<string, ExerciseSummary>();
  for (const day of days) {
    for (const [exerciseId, share] of Object.entries(exerciseDayTotals(day))) {
      if (!share.sets) continue;
      let summary = summaries.get(exerciseId);
      if (!summary) summaries.set(exerciseId, (summary = { exerciseId, totals: { sets: 0, activeDays: 0 }, bests: {} }));
      summary.totals.sets += share.sets;
      summary.totals.activeDays++;
      if (share.reps !== undefined) summary.totals.reps = (summary.totals.reps ?? 0) + share.reps;
      if (share.holdSeconds !== undefined) summary.totals.holdSeconds = (summary.totals.holdSeconds ?? 0) + share.holdSeconds;
      for (const best of ['bestSetReps', 'bestHoldSeconds', 'bestAddedWeightLbs'] as const) {
        if (share[best] !== undefined) summary.bests[best] = Math.max(summary.bests[best] ?? 0, share[best]!);
      }
    }
  }
  return [...summaries.values()].sort((a, b) => b.totals.sets - a.totals.sets || (a.exerciseId < b.exerciseId ? -1 : 1));
}

/** A friend's profile. Anyone else, and an id that isn't an account, gets the same 404, so ids don't reveal accounts. */
export async function viewProfile(db: Db, userId: string, body: Record<string, unknown>, clock: Clock): Promise<ProfileViewResponse> {
  const targetId = body.userId;
  const notFound = new RequestError(404, 'not found');
  if (typeof targetId !== 'string' || !targetId) throw notFound;
  if (targetId !== userId && !(await db.isFriend(userId, targetId))) throw notFound;
  const user = await db.getUser(targetId);
  if (!user) throw notFound;
  const allDays = (await db.dayTotalsBetween(targetId, '0000-01-01', '9999-12-31')).map(boardDay);
  const { days: _, ...profile } = boardMember(user, []);
  const firstRecentDay = addDays(dayKey(clock.now(), profile.timeZone), -(PROFILE_RECENT_DAYS - 1));
  return {
    profile,
    days: allDays.filter((day) => day.day >= firstRecentDay),
    exercises: summarizeExercises(allDays),
    definitions: await definitionsNamedBy(db, allDays),
  };
}
