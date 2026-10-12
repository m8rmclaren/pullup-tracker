import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/lambda/auth';
import { MemoryDb } from '../src/lambda/db';
import { route } from '../src/lambda/http';
import { sweepEmptyAccounts } from '../src/lambda/sweep';
import type { ChallengeListItem } from '../src/shared/model';
import { SoftAuthenticator } from './softAuthenticator';

const ORIGIN = 'https://pullups.example.com';
const SIGNUP_DAY = Date.parse('2026-10-08T18:00:00Z');
const DAY_MS = 86_400_000;
const OPERATOR_TOKEN = 'operator-device-token-0123456789';

/** The operator (pre-passkey, no marker) plus accounts made through real sign-ups, so each has a marker 30 days out. */
async function setup() {
  const db = new MemoryDb();
  db.users.set('op', { id: 'op', name: 'Hayden', createdAt: 1 });
  db.tokens.set(hashToken(OPERATOR_TOKEN), 'op');
  let nowMs = SIGNUP_DAY;
  const clock = { now: () => nowMs };
  const deps = { db, clock, webAuthn: { rpId: 'pullups.example.com', rpName: 'Pull-ups', origins: [ORIGIN] }, isSignupOpen: true };
  const call = (path: string, body: unknown = {}, token?: string) => route({ method: 'POST', path, headers: token ? { 'x-pullup-token': token } : {}, body: JSON.stringify(body) }, deps);
  const signUp = async (name: string) => {
    const options = await call('/api/signup/options', { name });
    return (await call('/api/signup', { credential: new SoftAuthenticator().create(options.body as never, ORIGIN) })).body as { token: string; account: { id: string } };
  };
  return { db, call, signUp, clock, setNow: (ms: number) => (nowMs = ms) };
}

describe('the empty-account sweep', () => {
  it('deletes an account still empty 30 days after sign-up, with its passkeys and tokens, and keeps the rest', async () => {
    const { db, call, signUp, clock, setNow } = await setup();
    const empty = await signUp('Empty');
    const logger = await signUp('Logger');
    const friendly = await signUp('Friendly');
    const challenger = await signUp('Challenger');
    await call('/api/sync', { protocolVersion: 2, pushedEntries: [{ id: 'set1', doneAt: SIGNUP_DAY, reps: 5, updatedAt: 1 }], sinceCursor: 0 }, logger.token);
    const { friendLink } = (await call('/api/friends', {}, OPERATOR_TOKEN)).body as { friendLink: string };
    await call('/api/links/redeem', { code: friendLink }, friendly.token);
    await call('/api/challenges/create', { exerciseId: 'pull-up', fromDay: '2026-10-08', toDay: '2026-10-31' }, challenger.token);
    await call('/api/friends', {}, empty.token);

    setNow(SIGNUP_DAY + 29 * DAY_MS);
    expect(await sweepEmptyAccounts(db, clock)).toEqual({ deleted: 0, kept: 0, remaining: 0 });

    setNow(SIGNUP_DAY + 30 * DAY_MS);
    expect(await sweepEmptyAccounts(db, clock)).toEqual({ deleted: 1, kept: 3, remaining: 0 });
    expect(db.users.has(empty.account.id)).toBe(false);
    expect(await db.passkeysOf(empty.account.id)).toEqual([]);
    expect(await db.userIdForToken(hashToken(empty.token))).toBeNull();
    expect(db.friendLinks.has(empty.account.id)).toBe(false);
    expect([...db.links.values()].some((link) => link.createdBy === empty.account.id)).toBe(false);
    expect((await call('/api/sync', { protocolVersion: 2, pushedEntries: [], sinceCursor: 0 }, empty.token)).status).toBe(401);
    for (const kept of [logger, friendly, challenger]) expect(db.users.has(kept.account.id)).toBe(true);
    expect(db.users.get('op')).toEqual({ id: 'op', name: 'Hayden', createdAt: 1 });

    // Each account is looked at once: one emptied later is never swept.
    await call('/api/friends/remove', { friendId: 'op' }, friendly.token);
    setNow(SIGNUP_DAY + 31 * DAY_MS);
    expect(await sweepEmptyAccounts(db, clock)).toEqual({ deleted: 0, kept: 0, remaining: 0 });
    expect(db.users.has(friendly.account.id)).toBe(true);
  });

  it('catches up on days a run missed', async () => {
    const { db, signUp, clock, setNow } = await setup();
    const empty = await signUp('Empty');
    setNow(SIGNUP_DAY + 45 * DAY_MS);
    expect((await sweepEmptyAccounts(db, clock)).deleted).toBe(1);
    expect(db.users.has(empty.account.id)).toBe(false);
  });

  it('stops starting accounts when its time is up, leaving them for the next run', async () => {
    const { db, signUp, setNow } = await setup();
    await signUp('One');
    await signUp('Two');
    let calls = 0;
    const slowClock = { now: () => SIGNUP_DAY + 30 * DAY_MS + (calls++ > 1 ? 7_000 : 0) };
    setNow(SIGNUP_DAY + 30 * DAY_MS);
    expect(await sweepEmptyAccounts(db, slowClock)).toEqual({ deleted: 1, kept: 0, remaining: 1 });
    expect(await sweepEmptyAccounts(db, { now: () => SIGNUP_DAY + 30 * DAY_MS })).toEqual({ deleted: 1, kept: 0, remaining: 0 });
  });

  it('keeps an account that only adopted an exercise or joined a challenge someone else made', async () => {
    const { db, call, signUp, clock, setNow } = await setup();
    const maker = await signUp('Maker');
    await call('/api/sync', { protocolVersion: 2, pushedEntries: [], pushedDefinitions: [{ id: 'x-keepkeepkeepkeep', name: 'Stairs', measure: 'count', unit: 'lap', createdAt: 1, updatedAt: 1 }], sinceCursor: 0 }, maker.token);
    const joiner = await signUp('Joiner');
    const { link } = (await call('/api/challenges/create', { exerciseId: 'pull-up', fromDay: '2026-10-08', toDay: '2026-10-31' }, OPERATOR_TOKEN)).body as ChallengeListItem;
    await call('/api/links/redeem', { code: link }, joiner.token);
    await call('/api/friends/remove', { friendId: 'op' }, joiner.token);
    setNow(SIGNUP_DAY + 30 * DAY_MS);
    expect(await sweepEmptyAccounts(db, clock)).toEqual({ deleted: 0, kept: 2, remaining: 0 });
  });
});
