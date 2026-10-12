import type { Friend, FriendsResponse } from '../shared/model';
import { type Db, PreconditionFailed } from './db';
import { newLink, newLinkCodePair } from './links';
import type { Clock } from './sync';

const MAX_ATTEMPTS = 8;
/** Bounds the fan-out of every read over friends (names here, day totals on the board). */
export const MAX_FRIENDS = 200;

export async function friendsOf(db: Db, userId: string): Promise<Friend[]> {
  const friendIds = (await db.friendIds(userId)).slice(0, MAX_FRIENDS);
  const users = await db.getUsers(friendIds);
  return [...users.values()].map(({ id, name }) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
}

/** The user's friend link, made the first time it's asked for. Two devices asking at once get the same one. */
export async function friendLinkOf(db: Db, userId: string, clock: Clock): Promise<string> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const current = await db.getFriendLink(userId);
    if (current) return current.code;
    const next = newLinkCodePair();
    try {
      await db.replaceFriendLink(userId, next, newLink('friend', userId, clock), null);
      return next.code;
    } catch (error) {
      if (!(error instanceof PreconditionFailed)) throw error;
    }
  }
  throw new Error(`gave up making a friend link for ${userId} after ${MAX_ATTEMPTS} conflicting writes`);
}

/** A new friend link; the old one stops resolving at once. */
export async function rotateFriendLink(db: Db, userId: string, clock: Clock): Promise<string> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const current = await db.getFriendLink(userId);
    const next = newLinkCodePair();
    try {
      await db.replaceFriendLink(userId, next, newLink('friend', userId, clock), current);
      return next.code;
    } catch (error) {
      if (!(error instanceof PreconditionFailed)) throw error;
    }
  }
  throw new Error(`gave up rotating the friend link of ${userId} after ${MAX_ATTEMPTS} conflicting writes`);
}

export async function friendsResponse(db: Db, userId: string, clock: Clock): Promise<FriendsResponse> {
  const [friends, friendLink] = await Promise.all([friendsOf(db, userId), friendLinkOf(db, userId, clock)]);
  return { friends, friendLink };
}
