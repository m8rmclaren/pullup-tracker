import { builtInExercise, isCreatedExerciseId } from '../shared/catalog';
import { type Definition, definitionKeyString } from '../shared/definitions';
import type { Challenge, ChallengeBoardResponse, ChallengeDay, ChallengeListItem, ChallengeSummary } from '../shared/model';
import { exerciseDayTotals } from '../shared/stats';
import { DEFAULT_TIME_ZONE, addDays, dayKey } from '../shared/time';
import { newDefinitionSuffix } from './auth';
import { parseWindow } from './boards';
import type { ChallengeJoin, Db, StoredDayTotal } from './db';
import { RequestError } from './errors';
import { newLink, newLinkCodePair } from './links';
import { type Clock, mapWithConcurrency } from './sync';

/** One bounded fan-out per board: every member's day totals for the window. */
export const MAX_CHALLENGE_MEMBERS = 200;
export const MAX_TARGET = 10_000_000;
/** How long after its last day a challenge link still resolves. */
const LINK_DAYS_AFTER_END = 7;
const NOT_FOUND = 'not found';

/** The last zone to finish `toDay` (UTC-12) finishes it at noon UTC the next day; a week after that, links stop. */
export function challengeLinkExpiresAt(toDay: string): number {
  return Date.parse(`${addDays(toDay, 1 + LINK_DAYS_AFTER_END)}T12:00:00Z`);
}

/** The writes that make `userId` a member: both sides of the membership, their own link, and the exercise adopted. */
export function memberJoin(userId: string, challenge: Challenge, clock: Clock, befriendId?: string): ChallengeJoin {
  const { code, codeHash } = newLinkCodePair();
  const join: ChallengeJoin = {
    userId,
    membership: { challengeId: challenge.id, joinedAt: clock.now(), toDay: challenge.toDay, linkCode: code, linkCodeHash: codeHash },
    link: newLink('challenge', userId, clock, { challengeId: challenge.id, expiresAt: challengeLinkExpiresAt(challenge.toDay) }),
  };
  if (isCreatedExerciseId(challenge.exerciseId)) join.adoptExerciseId = challenge.exerciseId;
  if (befriendId) join.befriendId = befriendId;
  return join;
}

/** A day cut down to one exercise: what a non-friend member may see. Days without that exercise are dropped. */
export function projectDays(days: StoredDayTotal[], exerciseId: string): ChallengeDay[] {
  const projected: ChallengeDay[] = [];
  for (const day of days) {
    const share = exerciseDayTotals(day)[exerciseId];
    if (share?.sets) projected.push({ day: day.day, ...share });
  }
  return projected;
}

const dayCount = (day: ChallengeDay) => (day.reps ?? 0) + (day.holdSeconds ?? 0);

async function exerciseDefinition(db: Db, exerciseId: string): Promise<Definition | undefined> {
  if (!isCreatedExerciseId(exerciseId)) return undefined;
  const stored = (await db.getDefinitions([{ exerciseId }])).get(definitionKeyString({ exerciseId }));
  if (!stored) return undefined;
  const { version: _, ...definition } = stored;
  return definition as Definition;
}

/** Every member's days for the challenge's exercise and window, projected on the server. */
async function memberDays(db: Db, challenge: Challenge, memberIds: string[]): Promise<Map<string, ChallengeDay[]>> {
  const days = await mapWithConcurrency(memberIds, 16, async (memberId) => [memberId, projectDays(await db.dayTotalsBetween(memberId, challenge.fromDay, challenge.toDay), challenge.exerciseId)] as const);
  return new Map(days);
}

/** The collective numbers a landing page leads with: no names, just the group. */
export async function challengeSummary(db: Db, challenge: Challenge): Promise<ChallengeSummary> {
  const memberIds = (await db.challengeMemberIds(challenge.id)).slice(0, MAX_CHALLENGE_MEMBERS);
  const [days, definition] = await Promise.all([memberDays(db, challenge, memberIds), exerciseDefinition(db, challenge.exerciseId)]);
  const groupTotal = [...days.values()].flat().reduce((total, day) => total + dayCount(day), 0);
  return { challenge, ...(definition ? { definition } : {}), memberCount: memberIds.length, groupTotal };
}

/** Built-ins anyone can use; a created exercise only if you've made it, logged it or joined a challenge on it. */
async function canSee(db: Db, userId: string, exerciseId: unknown): Promise<boolean> {
  if (typeof exerciseId !== 'string') return false;
  if (builtInExercise(exerciseId)) return true;
  if (!isCreatedExerciseId(exerciseId)) return false;
  return (await db.adoptedDefinitionKeys(userId)).some((key) => !key.variationId && key.exerciseId === exerciseId);
}

export async function createChallenge(db: Db, userId: string, body: Record<string, unknown>, clock: Clock): Promise<ChallengeListItem> {
  if (!(await canSee(db, userId, body.exerciseId))) throw new RequestError(404, "That exercise isn't one you can see.");
  const { fromDay, toDay } = parseWindow(body);
  const user = await db.getUser(userId);
  if (!user) throw new RequestError(401, 'This account no longer exists.');
  const today = dayKey(clock.now(), user.timeZone ?? DEFAULT_TIME_ZONE);
  if (toDay < today) throw new RequestError(400, 'A challenge has to end today or later.');
  if (fromDay > addDays(today, 365)) throw new RequestError(400, 'A challenge has to start within a year.');
  const { target } = body;
  if (target !== undefined && !(Number.isInteger(target) && (target as number) >= 1 && (target as number) <= MAX_TARGET)) throw new RequestError(400, `target must be a whole number from 1 to ${MAX_TARGET}.`);
  const challenge: Challenge = { id: `g-${newDefinitionSuffix()}`, exerciseId: body.exerciseId as string, fromDay, toDay, createdBy: userId, createdAt: clock.now() };
  if (target !== undefined) challenge.target = target as number;
  const join = memberJoin(userId, challenge, clock);
  await db.createChallenge(challenge, join);
  const definition = await exerciseDefinition(db, challenge.exerciseId);
  return { challenge, ...(definition ? { definition } : {}), memberCount: 1, link: join.membership.linkCode };
}

/** Your challenges, active first (soonest to end), then past ones (most recent first). */
export async function listChallenges(db: Db, userId: string, clock: Clock): Promise<ChallengeListItem[]> {
  const memberships = await db.membershipsOf(userId);
  const challenges = await db.getChallenges(memberships.map((membership) => membership.challengeId));
  const user = await db.getUser(userId);
  const today = dayKey(clock.now(), user?.timeZone ?? DEFAULT_TIME_ZONE);
  const items = await mapWithConcurrency(memberships, 8, async (membership): Promise<ChallengeListItem | null> => {
    const challenge = challenges.get(membership.challengeId);
    if (!challenge) return null;
    const [memberIds, definition] = await Promise.all([db.challengeMemberIds(challenge.id), exerciseDefinition(db, challenge.exerciseId)]);
    return { challenge, ...(definition ? { definition } : {}), memberCount: memberIds.length, link: membership.linkCode };
  });
  const isActive = (item: ChallengeListItem) => item.challenge.toDay >= today;
  return items
    .filter((item): item is ChallengeListItem => item !== null)
    .sort((a, b) => Number(isActive(b)) - Number(isActive(a)) || (isActive(a) ? (a.challenge.toDay < b.challenge.toDay ? -1 : 1) : a.challenge.toDay > b.challenge.toDay ? -1 : 1));
}

async function requireMembership(db: Db, userId: string, challengeId: unknown) {
  if (typeof challengeId !== 'string' || !challengeId) throw new RequestError(404, NOT_FOUND);
  const membership = await db.getMembership(userId, challengeId);
  if (!membership) throw new RequestError(404, NOT_FOUND);
  return membership;
}

export async function challengeLink(db: Db, userId: string, challengeId: unknown): Promise<{ link: string }> {
  return { link: (await requireMembership(db, userId, challengeId)).linkCode };
}

/** Leaving deletes your membership and your link; your sets stay yours. Answers the same whether or not you were a member. */
export async function leaveChallenge(db: Db, userId: string, challengeId: unknown): Promise<object> {
  if (typeof challengeId !== 'string') return {};
  const membership = await db.getMembership(userId, challengeId);
  if (membership) await db.leaveChallenge(userId, membership);
  return {};
}

/**
 * The board, members only. Each member's days leave the server cut down to the challenge's
 * exercise and window, friend or not, so a member never sees more of a stranger than that.
 */
export async function challengeBoard(db: Db, userId: string, challengeId: unknown): Promise<ChallengeBoardResponse> {
  const membership = await requireMembership(db, userId, challengeId);
  const challenge = await db.getChallenge(membership.challengeId);
  if (!challenge) throw new RequestError(404, NOT_FOUND);
  const memberIds = (await db.challengeMemberIds(challenge.id)).slice(0, MAX_CHALLENGE_MEMBERS);
  const [users, friendIds, days, definition] = await Promise.all([db.getUsers(memberIds), db.friendIds(userId), memberDays(db, challenge, memberIds), exerciseDefinition(db, challenge.exerciseId)]);
  const friends = new Set(friendIds);
  const members = [...users.values()].map((member) => ({ id: member.id, name: member.name, isFriend: friends.has(member.id), days: days.get(member.id) ?? [] }));
  const groupTotal = members.flatMap((member) => member.days).reduce((total, day) => total + dayCount(day), 0);
  return { challenge, ...(definition ? { definition } : {}), memberCount: members.length, groupTotal, members };
}
