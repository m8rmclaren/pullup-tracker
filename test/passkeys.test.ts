import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/lambda/auth';
import { MemoryDb } from '../src/lambda/db';
import { type RouteDeps, route } from '../src/lambda/http';
import { CHALLENGE_TTL_MS } from '../src/lambda/passkeys';
import type { Entry } from '../src/shared/model';
import { SoftAuthenticator } from './softAuthenticator';

const ORIGIN = 'https://pullups.example.com';
const WEB_AUTHN = { rpId: 'pullups.example.com', rpName: 'Pull-ups', origins: [ORIGIN] };
const OPERATOR_TOKEN = 'operator-device-token-0123456789';
const OCT8 = Date.parse('2026-10-08T18:00:00Z');

/** As the one production account is: made by a v1 invite, a device token, no passkey, a profile never edited. */
function operatorDb(): MemoryDb {
  const db = new MemoryDb();
  db.users.set('op', { id: 'op', name: 'Hayden', createdAt: 1 });
  db.tokens.set(hashToken(OPERATOR_TOKEN), 'op');
  return db;
}

function client(db: MemoryDb, overrides: Partial<RouteDeps> = {}) {
  let nowMs = OCT8;
  const deps: RouteDeps = { db, clock: { now: () => nowMs }, webAuthn: WEB_AUTHN, isSignupOpen: true, ...overrides };
  const post = (path: string, body: unknown = {}, token?: string) => route({ method: 'POST', path, headers: token ? { 'x-pullup-token': token } : {}, body: JSON.stringify(body) }, deps);
  return {
    post,
    advance: (ms: number) => (nowMs += ms),
    /** `timeZone` null sends none, as a client from before zones would. */
    async signUp(authenticator: SoftAuthenticator, name = 'Sam', timeZone: string | null = 'Europe/London') {
      const options = await post('/api/signup/options', timeZone === null ? { name } : { name, timeZone });
      expect(options.status).toBe(200);
      return post('/api/signup', { credential: authenticator.create(options.body as never, ORIGIN), label: 'Pixel' });
    },
    async signIn(authenticator: SoftAuthenticator, origin = ORIGIN) {
      const options = await post('/api/passkey/login/options');
      expect(options.status).toBe(200);
      return post('/api/passkey/login', { credential: authenticator.get(options.body as never, origin), label: 'Laptop' });
    },
    async addPasskey(authenticator: SoftAuthenticator, token: string) {
      const options = await post('/api/passkey/register/options', {}, token);
      expect(options.status).toBe(200);
      return post('/api/passkey/register', { credential: authenticator.create(options.body as never, ORIGIN), label: 'iPhone' }, token);
    },
  };
}

const sync = (post: ReturnType<typeof client>['post'], token: string, pushedEntries: Entry[] = []) => post('/api/sync', { protocolVersion: 2, pushedEntries, sinceCursor: 0 }, token);

describe('passkey sign-up', () => {
  it('makes an account from a name and a passkey, and signs this device in', async () => {
    const db = new MemoryDb();
    const { post, signUp } = client(db);
    const signedUp = await signUp(new SoftAuthenticator(), '  Sam  ', 'Europe/London');
    expect(signedUp).toMatchObject({ status: 200, body: { account: { name: 'Sam', timeZone: 'Europe/London' } } });
    const { token, account } = signedUp.body as { token: string; account: { id: string } };
    expect(await sync(post, token)).toMatchObject({ status: 200, body: { account: { id: account.id, name: 'Sam' } } });

    // The profile, passkey, token and sweep marker were written together; the profile has never been edited.
    expect(db.users.get(account.id)).toEqual({ id: account.id, name: 'Sam', createdAt: OCT8, timeZone: 'Europe/London' });
    expect(await db.passkeysOf(account.id)).toEqual([expect.objectContaining({ counter: 0, label: 'Pixel', createdAt: OCT8, transports: ['internal', 'hybrid'] })]);
    expect(db.sweepMarkers.get('2026-11-07')).toEqual(new Set([account.id]));
    expect(db.pendingChallenges.size).toBe(0);
  });

  it('is refused while sign-up is closed, and everything is refused without a domain', async () => {
    const closed = client(new MemoryDb(), { isSignupOpen: false });
    expect(await closed.post('/api/signup/options', { name: 'Sam' })).toMatchObject({ status: 403 });
    expect((await closed.post('/api/signup', { credential: {} })).status).toBe(403);

    const noDomain = client(operatorDb(), { webAuthn: undefined });
    expect((await noDomain.post('/api/signup/options', { name: 'Sam' })).status).toBe(503);
    expect((await noDomain.post('/api/passkey/login/options')).status).toBe(503);
    expect((await noDomain.post('/api/passkey/register/options', {}, OPERATOR_TOKEN)).status).toBe(503);
  });

  it('checks the name and zone before issuing a challenge', async () => {
    const db = new MemoryDb();
    const { post } = client(db);
    expect((await post('/api/signup/options', { name: '   ' })).status).toBe(400);
    expect((await post('/api/signup/options', { name: 'x'.repeat(25) })).status).toBe(400);
    expect((await post('/api/signup/options', { name: 'Sam', timeZone: 'Mars/Base' })).status).toBe(400);
    expect(db.pendingChallenges.size).toBe(0);
    expect(await post('/api/signup/options', { name: 'Sam' })).toMatchObject({ status: 200, body: { rp: { id: 'pullups.example.com' }, authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, attestation: 'none' } });
  });

  it('keeps the device’s goal on the new profile, without a clock so any edit beats it', async () => {
    const db = new MemoryDb();
    const { post } = client(db);
    const options = await post('/api/signup/options', { name: 'Gia', dailyGoalReps: 50 });
    const signedUp = await post('/api/signup', { credential: new SoftAuthenticator().create(options.body as never, ORIGIN) });
    const { account } = signedUp.body as { account: { id: string } };
    expect(signedUp.body).toMatchObject({ account: { dailyGoalReps: 50 } });
    expect(db.users.get(account.id)).not.toHaveProperty('goalUpdatedAt');
    for (const dailyGoalReps of [0, 1.5, '40', 10_001]) expect((await post('/api/signup/options', { name: 'Gia', dailyGoalReps })).status).toBe(400);
  });

  it('takes Denver from a client that sends no zone', async () => {
    const { signUp } = client(new MemoryDb());
    expect(await signUp(new SoftAuthenticator(), 'Old', null)).toMatchObject({ status: 200, body: { account: { timeZone: 'America/Denver' } } });
  });

  it('refuses a passkey made for another origin or domain, or without user verification', async () => {
    const db = new MemoryDb();
    const { post } = client(db);
    const wrongOrigin = await post('/api/signup/options', { name: 'Sam' });
    expect((await post('/api/signup', { credential: new SoftAuthenticator().create(wrongOrigin.body as never, 'https://evil.example') })).status).toBe(400);

    const wrongDomain = await post('/api/signup/options', { name: 'Sam' });
    const options = { ...(wrongDomain.body as { rp: object }), rp: { id: 'evil.example' } };
    expect((await post('/api/signup', { credential: new SoftAuthenticator().create(options as never, ORIGIN) })).status).toBe(400);

    const noFaceId = await post('/api/signup/options', { name: 'Sam' });
    expect((await post('/api/signup', { credential: new SoftAuthenticator({ verifiesUser: false }).create(noFaceId.body as never, ORIGIN) })).status).toBe(400);
    expect(db.users.size).toBe(0);
  });

  it('uses each challenge once, and not after it expires', async () => {
    const db = new MemoryDb();
    const { post, advance } = client(db);
    const options = await post('/api/signup/options', { name: 'Sam' });
    const credential = new SoftAuthenticator().create(options.body as never, ORIGIN);
    expect((await post('/api/signup', { credential })).status).toBe(200);
    expect(await post('/api/signup', { credential })).toMatchObject({ status: 400, body: { error: 'That took too long. Try again.' } });
    expect(db.users.size).toBe(1);

    const late = await post('/api/signup/options', { name: 'Late' });
    advance(CHALLENGE_TTL_MS);
    expect((await post('/api/signup', { credential: new SoftAuthenticator().create(late.body as never, ORIGIN) })).status).toBe(400);
    expect(db.users.size).toBe(1);
  });

  it('rejects junk in place of a credential', async () => {
    const { post } = client(new MemoryDb());
    for (const credential of [undefined, 'x', {}, { id: 'a', response: {} }, { id: 'a', response: { clientDataJSON: '!!' } }, { id: 'a'.repeat(600), response: { clientDataJSON: 'e30' } }]) {
      expect((await post('/api/signup', { credential })).status).toBe(400);
    }
  });
});

describe('passkey sign-in', () => {
  it('signs a wiped or new device into the same account, with its history', async () => {
    const db = new MemoryDb();
    const phone = new SoftAuthenticator();
    const { post, signUp, signIn } = client(db);
    const { token, account } = (await signUp(phone)).body as { token: string; account: { id: string } };
    const set: Entry = { id: 'set1', doneAt: OCT8, reps: 7, updatedAt: OCT8 };
    await sync(post, token, [set]);

    const signedIn = await signIn(phone);
    expect(signedIn).toMatchObject({ status: 200, body: { account: { id: account.id, name: 'Sam' } } });
    const newToken = (signedIn.body as { token: string }).token;
    expect(newToken).not.toBe(token);
    expect((await sync(post, newToken)).body).toMatchObject({ entries: [set] });
    expect((await sync(post, token)).status).toBe(200);
  });

  it('refuses a replayed response, a forged one and one for another origin', async () => {
    const db = new MemoryDb();
    const victim = new SoftAuthenticator();
    const { post, signUp, signIn } = client(db);
    const { account } = (await signUp(victim)).body as { account: { id: string } };

    const options = await post('/api/passkey/login/options');
    const credential = victim.get(options.body as never, ORIGIN);
    expect((await post('/api/passkey/login', { credential })).status).toBe(200);
    expect((await post('/api/passkey/login', { credential })).status).toBe(400);

    // Someone else's passkey that claims to be the victim's account finds no credential there.
    const attacker = new SoftAuthenticator();
    await signUp(attacker, 'Mallory');
    attacker.credentials[0]!.userHandle = Buffer.from(account.id).toString('base64url');
    expect((await signIn(attacker)).status).toBe(401);

    // The victim's credential id with a signature from another key.
    const forged = await post('/api/passkey/login/options');
    const signedByAttacker = attacker.get(forged.body as never, ORIGIN);
    const real = victim.get({ challenge: 'unused' }, ORIGIN);
    expect((await post('/api/passkey/login', { credential: { ...signedByAttacker, id: real.id, rawId: real.rawId, response: { ...signedByAttacker.response, userHandle: real.response.userHandle } } })).status).toBe(401);

    expect((await signIn(victim, 'https://evil.example')).status).toBe(401);
    expect(db.tokens.size).toBe(3);
  });

  it('won’t take a sign-up challenge for a sign-in', async () => {
    const db = new MemoryDb();
    const phone = new SoftAuthenticator();
    const { post, signUp } = client(db);
    await signUp(phone);
    const signupOptions = await post('/api/signup/options', { name: 'Again' });
    const challenge = (signupOptions.body as { challenge: string }).challenge;
    expect((await post('/api/passkey/login', { credential: phone.get({ challenge, rpId: WEB_AUTHN.rpId }, ORIGIN) })).status).toBe(400);
  });

  it('keeps a counting authenticator’s sign count', async () => {
    const db = new MemoryDb();
    const securityKey = new SoftAuthenticator({ countsSignatures: true });
    const { signUp, signIn } = client(db);
    const { account } = (await signUp(securityKey)).body as { account: { id: string } };
    expect((await signIn(securityKey)).status).toBe(200);
    expect((await signIn(securityKey)).status).toBe(200);
    expect((await db.passkeysOf(account.id))[0]!.counter).toBe(3);

    // A cloned key replays an old count.
    securityKey.credentials[0]!.signCount = 1;
    expect((await signIn(securityKey)).status).toBe(401);
  });

  it('refuses a passkey whose account is gone', async () => {
    const db = new MemoryDb();
    const phone = new SoftAuthenticator();
    const { signUp, signIn } = client(db);
    const { account } = (await signUp(phone)).body as { account: { id: string } };
    db.users.delete(account.id);
    expect((await signIn(phone)).status).toBe(401);
  });
});

describe('adding a passkey', () => {
  it('gives the operator’s pre-passkey account its first passkey, and the device token keeps working', async () => {
    const db = operatorDb();
    const phone = new SoftAuthenticator();
    const { post, addPasskey, signIn } = client(db, { isSignupOpen: false });
    await sync(post, OPERATOR_TOKEN, [{ id: 'v1set', doneAt: OCT8, reps: 6, updatedAt: OCT8 }]);
    expect(await post('/api/passkey/list', {}, OPERATOR_TOKEN)).toMatchObject({ status: 200, body: { passkeys: [] } });

    const added = await addPasskey(phone, OPERATOR_TOKEN);
    expect(added).toMatchObject({ status: 200, body: { passkeys: [{ label: 'iPhone', createdAt: OCT8 }] } });

    // Signing in after wiping Safari: a new token on the same account, with its history.
    const signedIn = await signIn(phone);
    expect(signedIn).toMatchObject({ status: 200, body: { account: { id: 'op', name: 'Hayden', timeZone: 'America/Denver' } } });
    expect((await sync(post, (signedIn.body as { token: string }).token)).body).toMatchObject({ entries: [{ id: 'v1set' }] });
    expect(await sync(post, OPERATOR_TOKEN)).toMatchObject({ status: 200, body: { account: { id: 'op' } } });
    expect(db.users.get('op')).toEqual({ id: 'op', name: 'Hayden', createdAt: 1 });
  });

  it('excludes passkeys already on the account, and keeps both', async () => {
    const db = operatorDb();
    const phone = new SoftAuthenticator();
    const laptop = new SoftAuthenticator();
    const { post, addPasskey } = client(db);
    await addPasskey(phone, OPERATOR_TOKEN);
    const options = await post('/api/passkey/register/options', {}, OPERATOR_TOKEN);
    expect((options.body as { excludeCredentials: { id: string }[] }).excludeCredentials).toEqual([expect.objectContaining({ id: (await db.passkeysOf('op'))[0]!.credentialId })]);
    expect(() => phone.create(options.body as never, ORIGIN)).toThrow(/already registered/);
    expect((await post('/api/passkey/register', { credential: laptop.create(options.body as never, ORIGIN) }, OPERATOR_TOKEN)).status).toBe(200);
    expect(await db.passkeysOf('op')).toHaveLength(2);
  });

  it('needs a signed-in device, and won’t finish another account’s challenge', async () => {
    const db = operatorDb();
    db.users.set('other', { id: 'other', name: 'Other', createdAt: 1 });
    db.tokens.set(hashToken('other-device-token-0123456789'), 'other');
    const { post } = client(db);
    expect((await post('/api/passkey/register/options')).status).toBe(401);
    expect((await post('/api/passkey/list')).status).toBe(401);
    const options = await post('/api/passkey/register/options', {}, OPERATOR_TOKEN);
    const credential = new SoftAuthenticator().create(options.body as never, ORIGIN);
    expect((await post('/api/passkey/register', { credential }, 'other-device-token-0123456789')).status).toBe(400);
    expect(await db.passkeysOf('other')).toEqual([]);
    expect(await db.passkeysOf('op')).toEqual([]);
  });
});

describe('invites after passkeys', () => {
  it('still redeems a device link, and refuses a friend invite from before passkeys', async () => {
    const db = operatorDb();
    const { post } = client(db);
    expect((await post('/api/invite', { kind: 'friend' }, OPERATOR_TOKEN)).status).toBe(400);
    const { code } = (await post('/api/invite', { kind: 'device' }, OPERATOR_TOKEN)).body as { code: string };
    const joined = await post('/api/join', { code });
    expect(joined).toMatchObject({ status: 200, body: { account: { id: 'op' } } });
    expect((await sync(post, (joined.body as { token: string }).token)).status).toBe(200);

    db.invites.set(hashToken('old-friend-invite-0123456789'), { kind: 'friend', createdBy: 'op', expiresAt: OCT8 + 86_400_000 });
    expect(await post('/api/join', { code: 'old-friend-invite-0123456789', name: 'Late' })).toMatchObject({ status: 410 });
    expect(db.users.size).toBe(1);
  });
});
