import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/lambda/auth';
import { MemoryDb } from '../src/lambda/db';
import { type RouteDeps, route } from '../src/lambda/http';
import { challengeBoardMembers, evaluateBoard, groupTotal } from '../src/shared/boards';
import type { ChallengeBoardResponse, ChallengeListItem, ChallengesResponse, Entry, ResolvedLink, SyncResponse } from '../src/shared/model';
import { SoftAuthenticator } from './softAuthenticator';

const ORIGIN = 'https://pullups.example.com';
const OCT14 = Date.parse('2026-10-14T18:00:00Z');
const STAIRS = { id: 'x-redrocksstairsaa', name: 'Red Rocks stairs', measure: 'count' as const, unit: 'lap', description: 'Bottom to top', createdAt: 1, updatedAt: 1 };
const TOKENS = { op: 'operator-device-token-0123456789', ana: 'ana-device-token-0123456789ab', ben: 'ben-device-token-0123456789ab', eve: 'eve-device-token-0123456789ab' } as const;
type Person = keyof typeof TOKENS;

/** Ana has created the stairs exercise; the operator is as production has them; Eve is a stranger to everyone. */
async function setup() {
  const db = new MemoryDb();
  for (const [id, token] of Object.entries(TOKENS)) {
    db.users.set(id, { id, name: id === 'op' ? 'Hayden' : id[0]!.toUpperCase() + id.slice(1), createdAt: 1 });
    db.tokens.set(hashToken(token), id);
  }
  let nowMs = OCT14;
  const deps: RouteDeps = { db, clock: { now: () => nowMs }, webAuthn: { rpId: 'pullups.example.com', rpName: 'Pull-ups', origins: [ORIGIN] }, isSignupOpen: true };
  const call = (path: string, body: unknown = {}, token?: string) => route({ method: 'POST', path, headers: token ? { 'x-pullup-token': token } : {}, body: JSON.stringify(body) }, deps);
  const post = (path: string, body: unknown = {}, as?: Person) => call(path, body, as ? TOKENS[as] : undefined);
  const sync = async (token: string, pushedEntries: Partial<Entry>[] = [], pushedDefinitions: unknown[] = []) => {
    const entries = pushedEntries.map((entry, i) => ({ id: `${token.slice(0, 6)}-${entry.doneAt}-${i}`, updatedAt: 1, ...entry }));
    const response = await call('/api/sync', { protocolVersion: 2, pushedEntries: entries, pushedDefinitions, sinceCursor: 0 }, token);
    expect(response.status).toBe(200);
    return response.body as SyncResponse;
  };
  await sync(TOKENS.ana, [], [STAIRS]);
  const create = async (body: Record<string, unknown> = {}, as: Person = 'ana') => post('/api/challenges/create', { exerciseId: STAIRS.id, fromDay: '2026-10-01', toDay: '2026-10-31', target: 1000, ...body }, as);
  const created = (await create()).body as ChallengeListItem;
  const signUp = async (name: string, linkCode: string) => {
    const options = await call('/api/signup/options', { name, linkCode });
    const signedUp = await call('/api/signup', { credential: new SoftAuthenticator().create(options.body as never, ORIGIN) });
    return signedUp.body as { token: string; account: { id: string }; redeemed?: { kind: string; challenge?: { memberCount: number } } };
  };
  return { db, post, call, sync, create, created, signUp, advance: (ms: number) => (nowMs += ms) };
}

const day = (iso: string) => Date.parse(iso);

describe('creating a challenge', () => {
  it('makes the creator its first member, with their own link', async () => {
    const { db, created } = await setup();
    expect(created).toMatchObject({ challenge: { exerciseId: STAIRS.id, fromDay: '2026-10-01', toDay: '2026-10-31', target: 1000, createdBy: 'ana' }, definition: { name: 'Red Rocks stairs' }, memberCount: 1 });
    expect(created.challenge.id).toMatch(/^g-[a-z2-7]{16}$/);
    expect(created.link).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(db.links.get(hashToken(created.link))).toMatchObject({ kind: 'challenge', createdBy: 'ana', challengeId: created.challenge.id, expiresAt: Date.parse('2026-11-08T12:00:00Z') });
  });

  it('needs an exercise you can see, a window of at most 62 days that hasn’t ended, and a sane target', async () => {
    const { post, create } = await setup();
    expect((await create({}, 'ben')).status).toBe(404);
    expect((await create({ exerciseId: 'x-zzzzzzzzzzzzzzzz' })).status).toBe(404);
    expect((await create({ exerciseId: 'not-a-built-in' })).status).toBe(404);
    expect((await create({ exerciseId: 'pull-up', target: undefined }, 'ben')).status).toBe(200);
    expect((await create({ toDay: '2026-12-15' })).status).toBe(400);
    expect((await create({ fromDay: '2026-09-01', toDay: '2026-09-30' })).status).toBe(400);
    expect((await create({ fromDay: '2027-11-01', toDay: '2027-11-30' })).status).toBe(400);
    for (const target of [0, 2.5, '1000', 20_000_000]) expect((await create({ target })).status).toBe(400);
    expect((await post('/api/challenges/create', { exerciseId: 'pull-up', fromDay: '2026-10-01', toDay: '2026-10-31' })).status).toBe(401);
  });
});

describe('challenge links', () => {
  it('resolves for anyone to the exercise and the group’s numbers, with no member names', async () => {
    const { post, sync, created } = await setup();
    await sync(TOKENS.ana, [{ doneAt: day('2026-10-10T16:00:00Z'), exerciseId: STAIRS.id, reps: 3 }]);
    const resolved = await post('/api/links/resolve', { code: created.link });
    expect(resolved.status).toBe(200);
    expect(resolved.body).toEqual({
      kind: 'challenge',
      inviterName: 'Ana',
      challenge: { challenge: created.challenge, definition: expect.objectContaining({ id: STAIRS.id, name: 'Red Rocks stairs', unit: 'lap', description: 'Bottom to top' }), memberCount: 1, groupTotal: 3 },
    } satisfies ResolvedLink);
  });

  it('joins whoever redeems it: friends with the sharer, a member, and the exercise adopted', async () => {
    const { db, post, call, sync, created } = await setup();
    const redeemed = await post('/api/links/redeem', { code: created.link }, 'ben');
    expect(redeemed).toMatchObject({ status: 200, body: { kind: 'challenge', friend: { id: 'ana', name: 'Ana' }, challenge: { memberCount: 2 } } });
    expect(await db.isFriend('ben', 'ana')).toBe(true);
    expect((await sync(TOKENS.ben)).definitions).toEqual([expect.objectContaining({ id: STAIRS.id })]);
    expect(db.links.get(hashToken(created.link))!.joinCount).toBe(1);

    // Idempotent, and joinCount counts only what was new.
    expect((await post('/api/links/redeem', { code: created.link }, 'ben')).status).toBe(200);
    expect(db.links.get(hashToken(created.link))!.joinCount).toBe(1);
    expect((await post('/api/links/redeem', { code: created.link }, 'ana')).status).toBe(400);

    // Ben's own link puts the next person in, as Ben's friend, not Ana's.
    const { link: benLink } = (await post('/api/challenges/link', { challengeId: created.challenge.id }, 'ben')).body as { link: string };
    expect(benLink).not.toBe(created.link);
    expect((await call('/api/links/redeem', { code: benLink }, TOKENS.eve)).status).toBe(200);
    expect(await db.isFriend('eve', 'ben')).toBe(true);
    expect(await db.isFriend('eve', 'ana')).toBe(false);
  });

  it('joins someone already friends with the sharer without a second friendship', async () => {
    const { db, post, created } = await setup();
    await db.befriend('ben', 'ana', 1);
    expect(await post('/api/links/redeem', { code: created.link }, 'ben')).toMatchObject({ status: 200, body: { challenge: { memberCount: 2 } } });
    expect(await db.friendIds('ben')).toEqual(['ana']);
  });

  it('lets the operator’s pre-passkey account join, leaving its profile alone', async () => {
    const { db, post, created } = await setup();
    expect((await post('/api/links/redeem', { code: created.link }, 'op')).status).toBe(200);
    expect(db.users.get('op')).toEqual({ id: 'op', name: 'Hayden', createdAt: 1 });
    expect(await db.getMembership('op', created.challenge.id)).toMatchObject({ toDay: '2026-10-31' });
  });

  it('stops resolving a week after the challenge ends', async () => {
    const { post, created, advance } = await setup();
    advance(Date.parse('2026-11-08T11:59:00Z') - OCT14);
    expect((await post('/api/links/resolve', { code: created.link })).status).toBe(200);
    advance(60_000);
    expect((await post('/api/links/resolve', { code: created.link })).status).toBe(404);
    expect((await post('/api/links/redeem', { code: created.link }, 'ben')).status).toBe(404);
  });

  it('turns people away once a challenge has 200 members', async () => {
    const { db, post, created } = await setup();
    for (let i = 0; i < 199; i++) db.memberships.set(`filler${i}`, new Map([[created.challenge.id, { challengeId: created.challenge.id, joinedAt: 1, toDay: '2026-10-31', linkCode: `c${i}`, linkCodeHash: `h${i}` }]]));
    expect(await post('/api/links/redeem', { code: created.link }, 'ben')).toMatchObject({ status: 409 });
    expect(await db.getMembership('ben', created.challenge.id)).toBeNull();
  });

  it('signs a new person up into the challenge in one write', async () => {
    const { db, created, signUp } = await setup();
    const signedUp = await signUp('Dee', created.link);
    expect(signedUp.redeemed).toMatchObject({ kind: 'challenge', challenge: { memberCount: 2 } });
    const deeId = signedUp.account.id;
    expect(db.users.get(deeId)!.joinedVia).toEqual({ kind: 'challenge', linkCreatedBy: 'ana' });
    expect(await db.isFriend(deeId, 'ana')).toBe(true);
    expect(await db.getMembership(deeId, created.challenge.id)).not.toBeNull();
    expect(await db.adoptedDefinitionKeys(deeId)).toEqual([{ exerciseId: STAIRS.id }]);
  });
});

describe('the challenge board', () => {
  /** Ana made it; Ben joined through Ana; Cat signed up through Ben's link, so she is no friend of Ana's. */
  async function threeMembers() {
    const context = await setup();
    const { post, sync, created, signUp } = context;
    await post('/api/links/redeem', { code: created.link }, 'ben');
    const { link: benLink } = (await post('/api/challenges/link', { challengeId: created.challenge.id }, 'ben')).body as { link: string };
    const cat = await signUp('Cat', benLink);
    await sync(TOKENS.ana, [{ doneAt: day('2026-10-02T16:00:00Z'), exerciseId: STAIRS.id, reps: 4 }]);
    await sync(TOKENS.ben, [{ doneAt: day('2026-10-12T16:00:00Z'), exerciseId: STAIRS.id, reps: 2 }]);
    await sync(cat.token, [
      { doneAt: day('2026-10-13T16:00:00Z'), exerciseId: STAIRS.id, reps: 5 },
      { doneAt: day('2026-10-13T17:00:00Z'), reps: 12 },
      { doneAt: day('2026-10-13T17:05:00Z'), exerciseId: 'plank', holdSeconds: 90 },
      { doneAt: day('2026-09-30T16:00:00Z'), exerciseId: STAIRS.id, reps: 50 },
    ]);
    return { ...context, cat };
  }

  it('shows every member’s name and that exercise’s days in the window, and nothing else of theirs', async () => {
    const { post, created, cat } = await threeMembers();
    const response = await post('/api/challenges/board', { challengeId: created.challenge.id }, 'ana');
    expect(response.status).toBe(200);
    const board = response.body as ChallengeBoardResponse;
    expect(board).toMatchObject({ challenge: created.challenge, memberCount: 3, groupTotal: 11, definition: { id: STAIRS.id } });
    const byName = new Map(board.members.map((member) => [member.name, member]));
    expect(byName.get('Ben')).toMatchObject({ id: 'ben', isFriend: true, days: [{ day: '2026-10-12', sets: 1, reps: 2, bestSetReps: 2 }] });
    expect(byName.get('Cat')).toEqual({ id: cat.account.id, name: 'Cat', isFriend: false, request: null, days: [{ day: '2026-10-13', sets: 1, reps: 5, bestSetReps: 5 }] });
    expect(byName.get('Ana')).toMatchObject({ isFriend: false, days: [{ day: '2026-10-02', reps: 4 }] });
    // No zone, goal, ring reps, holds, other exercises or days outside the window leave the server.
    const serialized = JSON.stringify(board);
    for (const leak of ['timeZone', 'dailyGoalReps', 'plank', 'holdSeconds', 'byExercise', '2026-09-30', '"reps":12']) expect(serialized).not.toContain(leak);

    // What the client does with it: the same specs as the friends board, over a fixed window.
    const members = challengeBoardMembers(STAIRS.id, board.members);
    const window = { fromDay: board.challenge.fromDay, toDay: board.challenge.toDay };
    expect(evaluateBoard({ metric: 'count', exerciseId: STAIRS.id, period: window }, members, OCT14).map((row) => [row.name, row.value, row.rank])).toEqual([
      ['Cat', 5, 1],
      ['Ana', 4, 2],
      ['Ben', 2, 3],
    ]);
    expect(groupTotal(STAIRS.id, window, members)).toBe(11);
  });

  it('is the same 404 for a stranger, a missing challenge and junk', async () => {
    const { post, created } = await threeMembers();
    const stranger = await post('/api/challenges/board', { challengeId: created.challenge.id }, 'eve');
    expect(stranger).toEqual({ status: 404, body: { error: 'not found' } });
    expect(await post('/api/challenges/board', { challengeId: 'g-zzzzzzzzzzzzzzzz' }, 'ana')).toEqual(stranger);
    expect(await post('/api/challenges/board', {}, 'ana')).toEqual(stranger);
    expect(await post('/api/challenges/link', { challengeId: created.challenge.id }, 'eve')).toEqual(stranger);
    expect((await post('/api/challenges/board', { challengeId: created.challenge.id })).status).toBe(401);
  });

  it('drops a member who leaves, kills their link, and keeps their sets', async () => {
    const { db, post, call, created, cat } = await threeMembers();
    const { link: catLink } = (await call('/api/challenges/link', { challengeId: created.challenge.id }, cat.token)).body as { link: string };
    expect(await call('/api/challenges/leave', { challengeId: created.challenge.id }, cat.token)).toEqual({ status: 200, body: {} });
    expect(await call('/api/challenges/leave', { challengeId: created.challenge.id }, cat.token)).toEqual({ status: 200, body: {} });
    expect((await call('/api/challenges/board', { challengeId: created.challenge.id }, cat.token)).status).toBe(404);
    expect((await post('/api/links/resolve', { code: catLink })).status).toBe(404);
    const board = (await post('/api/challenges/board', { challengeId: created.challenge.id }, 'ana')).body as ChallengeBoardResponse;
    expect(board.members.map((member) => member.name).sort()).toEqual(['Ana', 'Ben']);
    expect(board.groupTotal).toBe(6);
    expect(await db.entriesWrittenAfter(cat.account.id, 0)).toHaveLength(4);
  });
});

describe('listing challenges', () => {
  it('lists yours, active first, each with your own link and its member count', async () => {
    const { post, create, created, advance } = await setup();
    const short = (await create({ exerciseId: 'pull-up', fromDay: '2026-10-14', toDay: '2026-10-16', target: undefined })).body as ChallengeListItem;
    advance(5 * 86_400_000);
    await post('/api/links/redeem', { code: created.link }, 'ben');
    const { challenges } = (await post('/api/challenges/list', {}, 'ana')).body as ChallengesResponse;
    expect(challenges.map((item) => [item.challenge.id, item.memberCount, item.link])).toEqual([
      [created.challenge.id, 2, created.link],
      [short.challenge.id, 1, short.link],
    ]);
    expect(challenges[0]!.definition).toMatchObject({ id: STAIRS.id });
    expect(((await post('/api/challenges/list', {}, 'eve')).body as ChallengesResponse).challenges).toEqual([]);
  });
});
