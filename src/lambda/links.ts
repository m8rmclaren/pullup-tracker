import { hashToken, newLinkCode } from './auth';
import { type Db, type Link, type User, PreconditionFailed } from './db';
import type { Clock } from './sync';

const COUNTER_ATTEMPTS = 3;
export const LINK_GONE = 'This link has expired or was replaced.';

export function newLink(kind: Link['kind'], createdBy: string, clock: Clock, extra: Pick<Link, 'challengeId' | 'expiresAt'> = {}): Link {
  return { kind, createdBy, createdAt: clock.now(), openCount: 0, joinCount: 0, version: 1, ...extra };
}

export function newLinkCodePair(): { code: string; codeHash: string } {
  const code = newLinkCode();
  return { code, codeHash: hashToken(code) };
}

/** A link that still resolves, with its creator; null for an unknown, expired or orphaned code. */
export async function liveLink(db: Db, codeHash: string, clock: Clock): Promise<{ link: Link; creator: User } | null> {
  const link = await db.getLink(codeHash);
  if (!link || (link.expiresAt !== undefined && link.expiresAt <= clock.now())) return null;
  const creator = await db.getUser(link.createdBy);
  return creator ? { link, creator } : null;
}

/**
 * Bumps a growth counter with a read and a put conditional on the link's version (the API role
 * can't UpdateItem). Best effort: a counter is analytics, so after a few lost races it gives up
 * rather than fail the request it rides on.
 */
export async function bumpLinkCounter(db: Db, codeHash: string, counter: 'openCount' | 'joinCount'): Promise<void> {
  for (let attempt = 0; attempt < COUNTER_ATTEMPTS; attempt++) {
    const link = await db.getLink(codeHash);
    if (!link) return;
    try {
      await db.putLink(codeHash, { ...link, [counter]: link[counter] + 1, version: link.version + 1 }, link.version);
      return;
    } catch (error) {
      if (!(error instanceof PreconditionFailed)) throw error;
    }
  }
  console.error(`gave up bumping ${counter} on a link after ${COUNTER_ATTEMPTS} conflicting writes`);
}
