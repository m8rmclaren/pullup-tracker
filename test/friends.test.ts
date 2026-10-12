import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/lambda/auth';
import { MemoryDb } from '../src/lambda/db';
import { type RouteDeps, route } from '../src/lambda/http';
import { SoftAuthenticator } from './softAuthenticator';

const ORIGIN = 'https://pullups.example.com';
const OCT8 = Date.parse('2026-10-08T18:00:00Z');
const TOKENS = { op: 'operator-device-token-0123456789', ana: 'ana-device-token-0123456789ab', ben: 'ben-device-token-0123456789ab', cat: 'cat-device-token-0123456789ab' } as const;
type Person = keyof typeof TOKENS;

/** The operator as production has them (pre-passkey, no friend link, unversioned profile), plus three accounts. */
function setup(overrides: Partial<RouteDeps> = {}) {
  const db = new MemoryDb();
  for (const [id, token] of Object.entries(TOKENS)) {
    db.users.set(id, { id, name: id === 'op' ? 'Hayden' : id[0]!.toUpperCase() + id.slice(1), createdAt: 1 });
    db.tokens.set(hashToken(token), id);
  }
  const deps: RouteDeps = { db, clock: { now: () => OCT8 }, webAuthn: { rpId: 'pullups.example.com', rpName: 'Pull-ups', origins: [ORIGIN] }, isSignupOpen: true, ...overrides };
  const post = (path: string, body: unknown = {}, as?: Person) => route({ method: 'POST', path, headers: as ? { 'x-pullup-token': TOKENS[as] } : {}, body: JSON.stringify(body) }, deps);
  const linkOf = async (as: Person) => ((await post('/api/friends', {}, as)).body as { friendLink: string }).friendLink;
  const friendsOf = async (as: Person) => ((await post('/api/friends', {}, as)).body as { friends: { id: string }[] }).friends.map((friend) => friend.id);
  return { db, post, linkOf, friendsOf };
}

describe('friend links', () => {
  it('gives the operator’s pre-passkey account a link on first ask, the same one on every device', async () => {
    const { db, post, linkOf } = setup();
    const response = await post('/api/friends', {}, 'op');
    expect(response).toMatchObject({ status: 200, body: { friends: [] } });
    const code = (response.body as { friendLink: string }).friendLink;
    expect(code).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(await linkOf('op')).toBe(code);
    expect(db.links.get(hashToken(code))).toMatchObject({ kind: 'friend', createdBy: 'op', openCount: 0, joinCount: 0 });
    expect(db.users.get('op')).toEqual({ id: 'op', name: 'Hayden', createdAt: 1 });
  });

  it('makes one link when two devices ask at once', async () => {
    const { db, post } = setup();
    const codes = await Promise.all([1, 2, 3].map(async () => ((await post('/api/friends', {}, 'ana')).body as { friendLink: string }).friendLink));
    expect(new Set(codes).size).toBe(1);
    expect([...db.links.values()].filter((link) => link.createdBy === 'ana')).toHaveLength(1);
  });

  it('resolves for anyone with just the kind and the inviter’s name, counting opens', async () => {
    const { db, post, linkOf } = setup();
    const code = await linkOf('op');
    const resolved = await post('/api/links/resolve', { code });
    expect(resolved).toEqual({ status: 200, body: { kind: 'friend', inviterName: 'Hayden' } });
    await post('/api/links/resolve', { code }, 'ana');
    expect(db.links.get(hashToken(code))!.openCount).toBe(2);
  });

  it('befriends whoever redeems it, both ways, once', async () => {
    const { db, post, linkOf, friendsOf } = setup();
    const code = await linkOf('op');
    expect(await post('/api/links/redeem', { code }, 'ana')).toEqual({ status: 200, body: { kind: 'friend', friend: { id: 'op', name: 'Hayden' } } });
    expect(await friendsOf('op')).toEqual(['ana']);
    expect(await friendsOf('ana')).toEqual(['op']);
    expect((await post('/api/links/redeem', { code }, 'ana')).status).toBe(200);
    await post('/api/links/redeem', { code }, 'ben');
    expect(db.links.get(hashToken(code))!.joinCount).toBe(2);
    expect(await friendsOf('op')).toEqual(['ana', 'ben']);
    expect(await friendsOf('ben')).toEqual(['op']);
  });

  it('won’t befriend you with yourself', async () => {
    const { post, linkOf, friendsOf } = setup();
    expect(await post('/api/links/redeem', { code: await linkOf('ana') }, 'ana')).toMatchObject({ status: 400 });
    expect(await friendsOf('ana')).toEqual([]);
  });

  it('stops resolving the old link once rotated, and keeps friends made with it', async () => {
    const { post, linkOf, friendsOf } = setup();
    const oldCode = await linkOf('op');
    await post('/api/links/redeem', { code: oldCode }, 'ana');
    const rotated = await post('/api/friends/rotate-link', {}, 'op');
    const newCode = (rotated.body as { friendLink: string }).friendLink;
    expect(newCode).not.toBe(oldCode);
    expect(await linkOf('op')).toBe(newCode);
    expect((await post('/api/links/resolve', { code: oldCode })).status).toBe(404);
    expect((await post('/api/links/redeem', { code: oldCode }, 'ben')).status).toBe(404);
    expect((await post('/api/links/redeem', { code: newCode }, 'ben')).status).toBe(200);
    expect(await friendsOf('op')).toEqual(['ana', 'ben']);
  });

  it('answers 404 for a code that isn’t a live shared link: unknown, junk, a device link, an old friend invite, an orphan', async () => {
    const { db, post, linkOf } = setup();
    const { code: deviceCode } = (await post('/api/invite', { kind: 'device' }, 'op')).body as { code: string };
    db.invites.set(hashToken('old-friend-invite-0123456789'), { kind: 'friend', createdBy: 'op', expiresAt: OCT8 + 86_400_000 });
    const orphan = await linkOf('cat');
    db.users.delete('cat');
    for (const code of ['never-issued-code-0123456789', 'short', 42, deviceCode, 'old-friend-invite-0123456789', orphan]) {
      expect((await post('/api/links/resolve', { code })).status).toBe(404);
      expect((await post('/api/links/redeem', { code }, 'ana')).status).toBe(404);
    }
    expect(await db.friendIds('ana')).toEqual([]);
  });
});

describe('friends', () => {
  it('needs a signed-in device, and shows each account only its own friends', async () => {
    const { post, linkOf, friendsOf } = setup();
    expect((await post('/api/friends')).status).toBe(401);
    expect((await post('/api/friends/rotate-link')).status).toBe(401);
    expect((await post('/api/links/redeem', { code: await linkOf('op') })).status).toBe(401);
    await post('/api/links/redeem', { code: await linkOf('op') }, 'ana');
    expect(await post('/api/friends', {}, 'op')).toMatchObject({ body: { friends: [{ id: 'ana', name: 'Ana' }] } });
    expect(await friendsOf('ben')).toEqual([]);
  });

  it('removes a friend on both sides, and says the same for anyone who isn’t one', async () => {
    const { db, post, linkOf, friendsOf } = setup();
    await post('/api/links/redeem', { code: await linkOf('op') }, 'ana');
    expect(await post('/api/friends/remove', { friendId: 'op' }, 'ana')).toEqual({ status: 200, body: {} });
    expect(await friendsOf('ana')).toEqual([]);
    expect(await friendsOf('op')).toEqual([]);
    expect(await post('/api/friends/remove', { friendId: 'ben' }, 'ana')).toEqual({ status: 200, body: {} });
    expect(await post('/api/friends/remove', { friendId: 'no-such-account' }, 'ana')).toEqual({ status: 200, body: {} });
    expect((await post('/api/friends/remove', {}, 'ana')).status).toBe(400);
    expect(db.users.size).toBe(4);
  });
});

describe('signing up through a link', () => {
  async function signUp(post: ReturnType<typeof setup>['post'], body: Record<string, unknown>) {
    const options = await post('/api/signup/options', body);
    if (options.status !== 200) return options;
    return post('/api/signup', { credential: new SoftAuthenticator().create(options.body as never, ORIGIN) });
  }

  it('befriends the link’s creator in the same write and records how the account joined', async () => {
    const { db, post, linkOf, friendsOf } = setup();
    const code = await linkOf('op');
    const signedUp = await signUp(post, { name: 'Dee', timeZone: 'Europe/London', linkCode: code });
    expect(signedUp).toMatchObject({ status: 200, body: { account: { name: 'Dee' }, redeemed: { kind: 'friend', friend: { id: 'op', name: 'Hayden' } } } });
    const deeId = (signedUp.body as { account: { id: string } }).account.id;
    expect(await friendsOf('op')).toEqual([deeId]);
    expect(db.users.get(deeId)!.joinedVia).toEqual({ kind: 'friend', linkCreatedBy: 'op' });
    expect(db.links.get(hashToken(code))!.joinCount).toBe(1);
    expect((signedUp.body as { account: object }).account).not.toHaveProperty('joinedVia');
  });

  it('keeps joinedVia through profile edits', async () => {
    const { db, post, linkOf } = setup();
    const signedUp = await signUp(post, { name: 'Dee', linkCode: await linkOf('op') });
    const { token, account } = signedUp.body as { token: string; account: { id: string } };
    await route({ method: 'POST', path: '/api/profile', headers: { 'x-pullup-token': token }, body: JSON.stringify({ name: 'Deedee', nameUpdatedAt: 5 }) }, { db });
    expect(db.users.get(account.id)).toMatchObject({ name: 'Deedee', version: 1, joinedVia: { kind: 'friend', linkCreatedBy: 'op' } });
  });

  it('refuses a dead link up front, and makes a plain account if the link dies mid-sign-up', async () => {
    const { db, post, linkOf } = setup();
    expect((await signUp(post, { name: 'Dee', linkCode: 'never-issued-code-0123456789' })).status).toBe(404);
    expect(db.pendingChallenges.size).toBe(0);

    const code = await linkOf('op');
    const options = await post('/api/signup/options', { name: 'Eve', linkCode: code });
    await post('/api/friends/rotate-link', {}, 'op');
    const signedUp = await post('/api/signup', { credential: new SoftAuthenticator().create(options.body as never, ORIGIN) });
    expect(signedUp.status).toBe(200);
    expect(signedUp.body).not.toHaveProperty('redeemed');
    const eveId = (signedUp.body as { account: { id: string } }).account.id;
    expect(db.users.get(eveId)).not.toHaveProperty('joinedVia');
    expect(await db.friendIds('op')).toEqual([]);
  });

  it('is still closed through a link while sign-up is closed', async () => {
    const { post, linkOf } = setup({ isSignupOpen: false });
    expect((await signUp(post, { name: 'Dee', linkCode: await linkOf('op') })).status).toBe(403);
  });
});
