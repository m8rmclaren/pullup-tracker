import type { RedeemedLink, ResolvedLink } from '../shared/model';
import { hashToken } from './auth';
import { MAX_CHALLENGE_MEMBERS, challengeSummary, memberJoin } from './challenges';
import { type Db, PreconditionFailed } from './db';
import { RequestError } from './errors';
import { LINK_GONE, bumpLinkCounter, liveLink } from './links';
import type { Clock } from './sync';

const MAX_ATTEMPTS = 8;

/** What the landing page shows before anyone signs in: the inviter's name and, for a challenge, the exercise and the group's numbers. */
export async function resolveLink(db: Db, code: string, clock: Clock): Promise<ResolvedLink> {
  const codeHash = hashToken(code);
  const resolved = await liveLink(db, codeHash, clock);
  if (!resolved) throw new RequestError(404, LINK_GONE);
  const { link, creator } = resolved;
  const challenge = link.challengeId ? await db.getChallenge(link.challengeId) : null;
  if (link.kind === 'challenge' && !challenge) throw new RequestError(404, LINK_GONE);
  await bumpLinkCounter(db, codeHash, 'openCount');
  return { kind: link.kind, inviterName: creator.name, ...(challenge ? { challenge: await challengeSummary(db, challenge) } : {}) };
}

/**
 * Makes the friendship with the link's creator and, for a challenge link, the membership with
 * the exercise adopted, in one transaction. Idempotent; `joinCount` counts only redeems that
 * made something new.
 */
export async function redeemLink(db: Db, userId: string, code: string, clock: Clock): Promise<RedeemedLink> {
  const codeHash = hashToken(code);
  const resolved = await liveLink(db, codeHash, clock);
  if (!resolved) throw new RequestError(404, LINK_GONE);
  const { link, creator } = resolved;
  if (creator.id === userId) throw new RequestError(400, "That's your own link.");
  const challenge = link.challengeId ? await db.getChallenge(link.challengeId) : null;
  if (link.kind === 'challenge' && !challenge) throw new RequestError(404, LINK_GONE);

  let isNew = false;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const [isFriend, membership] = await Promise.all([db.isFriend(userId, creator.id), challenge ? db.getMembership(userId, challenge.id) : null]);
    try {
      if (challenge && !membership) {
        if ((await db.challengeMemberIds(challenge.id)).length >= MAX_CHALLENGE_MEMBERS) throw new RequestError(409, 'This challenge is full.');
        await db.joinChallenge(memberJoin(userId, challenge, clock, isFriend ? undefined : creator.id));
        isNew = true;
      } else if (!isFriend) {
        await db.befriend(userId, creator.id, clock.now());
        isNew = true;
      }
      break;
    } catch (error) {
      if (!(error instanceof PreconditionFailed)) throw error;
      if (attempt === MAX_ATTEMPTS - 1) throw new Error(`gave up redeeming a link for ${userId} after ${MAX_ATTEMPTS} conflicting writes`);
    }
  }
  if (isNew) await bumpLinkCounter(db, codeHash, 'joinCount');
  return { kind: link.kind, friend: { id: creator.id, name: creator.name }, ...(challenge ? { challenge: await challengeSummary(db, challenge) } : {}) };
}
