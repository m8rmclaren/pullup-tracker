import type { IncomingRequest, RequestState, Suggestion } from '../shared/model';
import { DEFAULT_TIME_ZONE, addDays, dayKey, wallClockToEpochMs } from '../shared/time';
import { type Db, PreconditionFailed } from './db';
import { RequestError } from './errors';
import type { Clock } from './sync';

/** Per sender per local day: requests only go to fellow challenge members, but a big challenge is still a list. */
export const MAX_REQUESTS_PER_DAY = 50;
const MAX_ATTEMPTS = 8;
/** Suggestions read each challenge's members, so only the most recent challenges are looked at. */
const SUGGESTION_CHALLENGES = 20;
const NOT_FOUND = 'not found';

/**
 * Whether `userId` may request `targetId` through `challengeId`: both are members of it, now or
 * after it ended. It is the one place eligibility is decided, so another source (friends of
 * friends) is an added check here. Anyone else gets the same 404 as an id that isn't an
 * account, so the endpoint can't probe for accounts.
 */
async function requireEligible(db: Db, userId: string, targetId: unknown, challengeId: unknown): Promise<string> {
  if (typeof targetId !== 'string' || typeof challengeId !== 'string' || targetId === userId) throw new RequestError(404, NOT_FOUND);
  const [mine, theirs] = await Promise.all([db.getMembership(userId, challengeId), db.getMembership(targetId, challengeId)]);
  if (!mine || !theirs) throw new RequestError(404, NOT_FOUND);
  return targetId;
}

/** Counts one more request against today's cap, or refuses it. A read and a version-conditional put, since the role can't UpdateItem. */
async function countRequest(db: Db, userId: string, clock: Clock): Promise<void> {
  const user = await db.getUser(userId);
  const timeZone = user?.timeZone ?? DEFAULT_TIME_ZONE;
  const today = dayKey(clock.now(), timeZone);
  const ttlEpochSeconds = Math.ceil(wallClockToEpochMs(addDays(today, 2), '00:00', timeZone) / 1000);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const stored = await db.getDailyCount(userId, 'requests', today);
    if ((stored?.count ?? 0) >= MAX_REQUESTS_PER_DAY) throw new RequestError(429, "That's all the friend requests for today.");
    try {
      await db.putDailyCount(userId, 'requests', today, { count: (stored?.count ?? 0) + 1, version: (stored?.version ?? 0) + 1 }, stored?.version ?? null, ttlEpochSeconds);
      return;
    } catch (error) {
      if (!(error instanceof PreconditionFailed)) throw error;
    }
  }
  throw new Error(`gave up counting a friend request for ${userId} after ${MAX_ATTEMPTS} conflicting writes`);
}

async function accept(db: Db, userId: string, fromUserId: string, clock: Clock): Promise<void> {
  try {
    await db.acceptRequest(userId, fromUserId, clock.now());
  } catch (error) {
    // Already friends: nothing to accept.
    if (!(error instanceof PreconditionFailed)) throw error;
  }
}

/**
 * Sends a request, idempotently. A request to someone who already requested you accepts theirs.
 * A request someone declined reads as sent and changes nothing on their side.
 */
export async function sendRequest(db: Db, userId: string, body: Record<string, unknown>, clock: Clock): Promise<{ status: 'requested' | 'friends' }> {
  const targetId = await requireEligible(db, userId, body.userId, body.challengeId);
  const challengeId = body.challengeId as string;
  if (await db.isFriend(userId, targetId)) return { status: 'friends' };
  if (await db.getIncomingRequest(userId, targetId)) {
    await accept(db, userId, targetId, clock);
    return { status: 'friends' };
  }
  if (await db.getSentRequest(userId, targetId)) return { status: 'requested' };
  const theirSide = await db.getIncomingRequest(targetId, userId);
  if (theirSide?.declinedAt !== undefined) {
    await db.putSentRequest(userId, { userId: targetId, challengeId: theirSide.challengeId, createdAt: theirSide.createdAt });
    return { status: 'requested' };
  }
  await countRequest(db, userId, clock);
  try {
    await db.sendRequest(userId, targetId, challengeId, clock.now());
  } catch (error) {
    if (!(error instanceof PreconditionFailed)) throw error;
  }
  return { status: 'requested' };
}

/** Accepts or declines a request waiting on you. A decline is silent: the sender's side is left as it was. */
export async function respondToRequest(db: Db, userId: string, body: Record<string, unknown>, clock: Clock): Promise<{ status: 'friends' } | object> {
  if (typeof body.userId !== 'string' || typeof body.accept !== 'boolean') throw new RequestError(400, 'userId and accept are required.');
  const request = await db.getIncomingRequest(userId, body.userId);
  if (!request) throw new RequestError(404, NOT_FOUND);
  if (!body.accept) {
    await db.declineRequest(userId, body.userId, clock.now());
    return {};
  }
  await accept(db, userId, body.userId, clock);
  return { status: 'friends' };
}

export async function cancelRequest(db: Db, userId: string, body: Record<string, unknown>): Promise<object> {
  if (typeof body.userId !== 'string' || !body.userId) throw new RequestError(400, 'userId is required.');
  await db.cancelRequest(userId, body.userId);
  return {};
}

/** Requests waiting on this user, for the sync response, so every client can badge Friends without polling. */
export async function incomingRequestsFor(db: Db, userId: string): Promise<IncomingRequest[]> {
  const pending = (await db.incomingRequests(userId)).filter((request) => request.declinedAt === undefined);
  if (!pending.length) return [];
  const users = await db.getUsers(pending.map((request) => request.userId));
  return pending.flatMap((request) => {
    const sender = users.get(request.userId);
    return sender ? [{ id: sender.id, name: sender.name, challengeId: request.challengeId }] : [];
  });
}

/** How each person stands with this user: `received` only for live requests, `sent` even after a silent decline. */
export async function requestStates(db: Db, userId: string): Promise<(otherUserId: string) => RequestState> {
  const [sent, received] = await Promise.all([db.sentRequests(userId), db.incomingRequests(userId)]);
  const sentTo = new Set(sent.map((request) => request.userId));
  const receivedFrom = new Set(received.filter((request) => request.declinedAt === undefined).map((request) => request.userId));
  return (otherUserId) => (receivedFrom.has(otherUserId) ? 'received' : sentTo.has(otherUserId) ? 'sent' : null);
}

/** People from your challenges you aren't friends with, so they're easy to find after a challenge ends. */
export async function suggestions(db: Db, userId: string): Promise<Suggestion[]> {
  const memberships = (await db.membershipsOf(userId)).sort((a, b) => b.joinedAt - a.joinedAt).slice(0, SUGGESTION_CHALLENGES);
  const [friendIds, stateOf] = await Promise.all([db.friendIds(userId), requestStates(db, userId)]);
  const friends = new Set(friendIds);
  const sharedChallenge = new Map<string, string>();
  for (const membership of memberships) {
    for (const memberId of await db.challengeMemberIds(membership.challengeId)) {
      if (memberId !== userId && !friends.has(memberId) && !sharedChallenge.has(memberId)) sharedChallenge.set(memberId, membership.challengeId);
    }
  }
  const users = await db.getUsers([...sharedChallenge.keys()]);
  return [...users.values()]
    .map((user) => ({ id: user.id, name: user.name, challengeId: sharedChallenge.get(user.id)!, request: stateOf(user.id) }))
    .sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
}
