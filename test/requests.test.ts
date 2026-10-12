import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/lambda/auth';
import { MemoryDb } from '../src/lambda/db';
import { type RouteDeps, route } from '../src/lambda/http';
import { MAX_REQUESTS_PER_DAY } from '../src/lambda/requests';
import type { ChallengeBoardResponse, ChallengeListItem, Suggestion, SyncResponse } from '../src/shared/model';

const OCT14 = Date.parse('2026-10-14T18:00:00Z');
const TOKENS = { op: 'operator-device-token-0123456789', ana: 'ana-device-token-0123456789ab', ben: 'ben-device-token-0123456789ab', cat: 'cat-device-token-0123456789ab', eve: 'eve-device-token-0123456789ab' } as const;
type Person = keyof typeof TOKENS;

/**
 * Ana starts a challenge; Ben joins through Ana's link and Cat through Ben's, so Ana and Cat
 * share a challenge without being friends. The operator (pre-passkey) joins through Ana's
 * too. Eve shares nothing with anyone.
 */
async function setup() {
  const db = new MemoryDb();
  for (const [id, token] of Object.entries(TOKENS)) {
    db.users.set(id, { id, name: id === 'op' ? 'Hayden' : id[0]!.toUpperCase() + id.slice(1), createdAt: 1 });
    db.tokens.set(hashToken(token), id);
  }
  let nowMs = OCT14;
  const deps: RouteDeps = { db, clock: { now: () => nowMs } };
  const post = (path: string, body: unknown = {}, as?: Person) => route({ method: 'POST', path, headers: as ? { 'x-pullup-token': TOKENS[as] } : {}, body: JSON.stringify(body) }, deps);
  const { challenge, link } = (await post('/api/challenges/create', { exerciseId: 'pull-up', fromDay: '2026-10-01', toDay: '2026-10-31' }, 'ana')).body as ChallengeListItem;
  await post('/api/links/redeem', { code: link }, 'ben');
  await post('/api/links/redeem', { code: link }, 'op');
  const { link: benLink } = (await post('/api/challenges/link', { challengeId: challenge.id }, 'ben')).body as { link: string };
  await post('/api/links/redeem', { code: benLink }, 'cat');
  await db.unfriend('op', 'ana');
  const request = (from: Person, to: string, challengeId = challenge.id) => post('/api/friends/request', { userId: to, challengeId }, from);
  const incoming = async (as: Person) => ((await post('/api/sync', { protocolVersion: 2, pushedEntries: [], sinceCursor: 0 }, as)).body as SyncResponse).account.incomingRequests;
  const suggestionsOf = async (as: Person) => ((await post('/api/friends/suggestions', {}, as)).body as { suggestions: Suggestion[] }).suggestions;
  const boardStateOf = async (as: Person, memberId: string) => ((await post('/api/challenges/board', { challengeId: challenge.id }, as)).body as ChallengeBoardResponse).members.find((member) => member.id === memberId);
  /** Everything the sender can observe about a request to `to`. */
  const senderView = async (from: Person, to: string) => ({ board: await boardStateOf(from, to), suggestions: await suggestionsOf(from), resend: (await request(from, to)).body });
  return { db, post, challenge, request, incoming, suggestionsOf, boardStateOf, senderView, advance: (ms: number) => (nowMs += ms) };
}

describe('friend requests', () => {
  it('go to a fellow member and arrive in their sync, named by the shared challenge', async () => {
    const { db, request, incoming, suggestionsOf, boardStateOf, challenge } = await setup();
    expect(await request('ana', 'cat')).toEqual({ status: 200, body: { status: 'requested' } });
    expect(await incoming('cat')).toEqual([{ id: 'ana', name: 'Ana', challengeId: challenge.id }]);
    expect(await incoming('ana')).toEqual([]);
    expect(await boardStateOf('ana', 'cat')).toMatchObject({ isFriend: false, request: 'sent' });
    expect(await boardStateOf('cat', 'ana')).toMatchObject({ isFriend: false, request: 'received' });
    expect(await boardStateOf('ana', 'ben')).toMatchObject({ isFriend: true, request: null });
    expect(await suggestionsOf('ana')).toEqual([
      { id: 'op', name: 'Hayden', challengeId: challenge.id, request: null },
      { id: 'cat', name: 'Cat', challengeId: challenge.id, request: 'sent' },
    ].sort((a, b) => a.name.localeCompare(b.name)));
    expect(await db.isFriend('ana', 'cat')).toBe(false);
  });

  it('befriend both sides in one tap on accept, and leave nothing pending', async () => {
    const { db, post, request, incoming, suggestionsOf } = await setup();
    await request('ana', 'cat');
    expect(await post('/api/friends/respond', { userId: 'ana', accept: true }, 'cat')).toEqual({ status: 200, body: { status: 'friends' } });
    expect(await db.isFriend('ana', 'cat')).toBe(true);
    expect(await db.isFriend('cat', 'ana')).toBe(true);
    expect(await incoming('cat')).toEqual([]);
    expect(await db.sentRequests('ana')).toEqual([]);
    expect((await suggestionsOf('ana')).map((suggestion) => suggestion.id)).toEqual(['op']);
    expect(await request('ana', 'cat')).toEqual({ status: 200, body: { status: 'friends' } });
  });

  it('befriend at once when both send one', async () => {
    const { db, request, incoming } = await setup();
    await request('ana', 'cat');
    expect(await request('cat', 'ana')).toEqual({ status: 200, body: { status: 'friends' } });
    expect(await db.isFriend('ana', 'cat')).toBe(true);
    expect(await incoming('ana')).toEqual([]);
    expect(await incoming('cat')).toEqual([]);
  });

  it('decline silently: the sender sees exactly what they saw before, and can’t send it again', async () => {
    const { db, post, request, incoming, senderView } = await setup();
    await request('ana', 'cat');
    const before = await senderView('ana', 'cat');
    expect(await post('/api/friends/respond', { userId: 'ana', accept: false }, 'cat')).toEqual({ status: 200, body: {} });
    expect(await senderView('ana', 'cat')).toEqual(before);
    expect(before.resend).toEqual({ status: 'requested' });
    expect(await incoming('cat')).toEqual([]);
    expect(await db.isFriend('ana', 'cat')).toBe(false);

    // Cancelling and asking again still reaches nobody.
    expect(await post('/api/friends/cancel', { userId: 'cat' }, 'ana')).toEqual({ status: 200, body: {} });
    expect(await request('ana', 'cat')).toEqual({ status: 200, body: { status: 'requested' } });
    expect(await incoming('cat')).toEqual([]);
    expect(await senderView('ana', 'cat')).toEqual(before);
  });

  it('can be cancelled by the sender, on both sides', async () => {
    const { db, post, request, incoming, boardStateOf } = await setup();
    await request('ana', 'cat');
    await post('/api/friends/cancel', { userId: 'cat' }, 'ana');
    expect(await incoming('cat')).toEqual([]);
    expect(await boardStateOf('ana', 'cat')).toMatchObject({ request: null });
    expect(await db.sentRequests('ana')).toEqual([]);
    expect(await request('ana', 'cat')).toEqual({ status: 200, body: { status: 'requested' } });
    expect(await incoming('cat')).toHaveLength(1);
  });

  it('answer the same 404 for anyone who isn’t a fellow member, and for ids that aren’t accounts', async () => {
    const { post, request, challenge } = await setup();
    const stranger = await request('ana', 'eve');
    expect(stranger).toEqual({ status: 404, body: { error: 'not found' } });
    expect(await request('ana', 'no-such-account')).toEqual(stranger);
    expect(await request('ana', 'ana')).toEqual(stranger);
    expect(await request('eve', 'ana')).toEqual(stranger);
    expect(await request('ana', 'cat', 'g-zzzzzzzzzzzzzzzz')).toEqual(stranger);
    expect(await post('/api/friends/request', { userId: 'cat' }, 'ana')).toEqual(stranger);
    expect(await post('/api/friends/respond', { userId: 'eve', accept: true }, 'ana')).toEqual(stranger);
    expect((await post('/api/friends/request', { userId: 'cat', challengeId: challenge.id })).status).toBe(401);
  });

  it('stay possible after the challenge ends, and stop when a member leaves', async () => {
    const { post, request, challenge, advance } = await setup();
    advance(30 * 86_400_000);
    expect(await request('ana', 'cat')).toEqual({ status: 200, body: { status: 'requested' } });
    await post('/api/friends/cancel', { userId: 'cat' }, 'ana');
    await post('/api/challenges/leave', { challengeId: challenge.id }, 'cat');
    expect((await request('ana', 'cat')).status).toBe(404);
  });

  it('reach the operator’s pre-passkey account, and arrive in its sync', async () => {
    const { request, incoming, challenge } = await setup();
    await request('cat', 'op');
    expect(await incoming('op')).toEqual([{ id: 'cat', name: 'Cat', challengeId: challenge.id }]);
  });

  it('stop at 50 a day per sender, counting only new requests', async () => {
    const { db, request, challenge, advance } = await setup();
    for (let i = 0; i < MAX_REQUESTS_PER_DAY + 1; i++) {
      db.users.set(`fan${i}`, { id: `fan${i}`, name: `Fan ${i}`, createdAt: 1 });
      db.memberships.set(`fan${i}`, new Map([[challenge.id, { challengeId: challenge.id, joinedAt: 1, toDay: challenge.toDay, linkCode: `c${i}`, linkCodeHash: `h${i}` }]]));
    }
    for (let i = 0; i < MAX_REQUESTS_PER_DAY; i++) expect((await request('ana', `fan${i}`)).status).toBe(200);
    expect((await request('ana', 'fan0')).status).toBe(200);
    expect(await request('ana', `fan${MAX_REQUESTS_PER_DAY}`)).toMatchObject({ status: 429 });
    advance(86_400_000);
    expect((await request('ana', `fan${MAX_REQUESTS_PER_DAY}`)).status).toBe(200);
  });
});
