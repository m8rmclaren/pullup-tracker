import { randomBytes } from 'node:crypto';
import { type AuthenticationResponseJSON, type RegistrationResponseJSON, generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import { type PasskeySummary, type SessionResponse, type SignupResponse, cleanName } from '../shared/model';
import { MAX_DAILY_GOAL_REPS, MIN_DAILY_GOAL_REPS } from '../shared/profile';
import { DEFAULT_TIME_ZONE, addDays, dayKey, isValidTimeZone } from '../shared/time';
import { hashToken, isPlausibleSecret, newSecret, newUserId } from './auth';
import { type ChallengePurpose, type Db, type NewAccount, type Passkey, type PendingChallenge, type User, PreconditionFailed } from './db';
import { bumpLinkCounter, liveLink } from './links';
import { RequestError } from './errors';
import { accountOf } from './profile';
import type { Clock } from './sync';

/** Where passkeys are bound. Every credential belongs to `rpId` for good, so it is the app's final domain. */
export interface WebAuthnConfig {
  rpId: string;
  rpName: string;
  /** Origins a response may come from, e.g. `https://pullups.example.com`. */
  origins: string[];
}

export const CHALLENGE_TTL_MS = 5 * 60_000;
/** An account with nothing in it this long after sign-up is deleted by the sweep. */
export const EMPTY_ACCOUNT_SWEEP_DAYS = 30;
export const MAX_PASSKEY_LABEL_LENGTH = 40;
// Discoverable passkeys have ids of 16 to 64 bytes; a sort key holds at most 1024.
const MAX_CREDENTIAL_ID_LENGTH = 512;

const STALE_CHALLENGE = 'That took too long. Try again.';
const UNVERIFIED = "That passkey couldn't be verified.";

const base64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

async function issueChallenge(db: Db, challenge: Omit<PendingChallenge, 'expiresAt'>, clock: Clock): Promise<Uint8Array<ArrayBuffer>> {
  const challengeBytes = new Uint8Array(randomBytes(32));
  await db.putChallenge(hashToken(base64url(challengeBytes)), { ...challenge, expiresAt: clock.now() + CHALLENGE_TTL_MS });
  return challengeBytes;
}

interface CredentialJson {
  id: string;
  response: { clientDataJSON: string; userHandle?: string };
}

function isCredentialJson(value: unknown): value is CredentialJson {
  if (!value || typeof value !== 'object') return false;
  const { id, response } = value as Record<string, unknown>;
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_CREDENTIAL_ID_LENGTH && !!response && typeof response === 'object' && typeof (response as Record<string, unknown>).clientDataJSON === 'string';
}

/**
 * Takes the challenge a response was signed over, so it can't be replayed whether or not the
 * response verifies. Returns the challenge as the response carries it.
 */
async function takeChallengeFor(db: Db, credential: unknown, purpose: ChallengePurpose, clock: Clock): Promise<{ credential: CredentialJson; challenge: string; pending: PendingChallenge }> {
  if (!isCredentialJson(credential)) throw new RequestError(400, 'credential must be a WebAuthn response.');
  let challenge: unknown;
  try {
    challenge = (JSON.parse(Buffer.from(credential.response.clientDataJSON, 'base64url').toString('utf8')) as { challenge?: unknown }).challenge;
  } catch {
    throw new RequestError(400, 'credential must be a WebAuthn response.');
  }
  if (typeof challenge !== 'string' || challenge.length > 256) throw new RequestError(400, 'credential must be a WebAuthn response.');
  const pending = await db.takeChallenge(hashToken(challenge));
  if (!pending || pending.purpose !== purpose || pending.expiresAt <= clock.now()) throw new RequestError(400, STALE_CHALLENGE);
  return { credential, challenge, pending };
}

async function verifyNewPasskey(config: WebAuthnConfig, credential: CredentialJson, challenge: string, rawLabel: unknown, clock: Clock): Promise<Passkey> {
  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verification = await verifyRegistrationResponse({ response: credential as unknown as RegistrationResponseJSON, expectedChallenge: challenge, expectedOrigin: config.origins, expectedRPID: config.rpId, requireUserVerification: true });
  } catch {
    throw new RequestError(400, UNVERIFIED);
  }
  if (!verification.verified) throw new RequestError(400, UNVERIFIED);
  const { id, publicKey, counter, transports } = verification.registrationInfo.credential;
  if (id.length > MAX_CREDENTIAL_ID_LENGTH) throw new RequestError(400, UNVERIFIED);
  const passkey: Passkey = { credentialId: id, publicKey: base64url(publicKey), counter, createdAt: clock.now() };
  if (transports?.length) passkey.transports = transports;
  const label = cleanName(rawLabel, MAX_PASSKEY_LABEL_LENGTH);
  if (label) passkey.label = label;
  return passkey;
}

function registrationOptions(config: WebAuthnConfig, userId: string, name: string, challenge: Uint8Array<ArrayBuffer>, existing: Passkey[] = []) {
  return generateRegistrationOptions({
    rpName: config.rpName,
    rpID: config.rpId,
    userID: new TextEncoder().encode(userId),
    userName: name,
    userDisplayName: name,
    challenge,
    timeout: CHALLENGE_TTL_MS,
    attestationType: 'none',
    excludeCredentials: existing.map((passkey) => ({ id: passkey.credentialId, transports: passkey.transports })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
}

/** The first half of sign-up: holds the name, zone and any link with a fresh user id until the passkey exists. */
export async function startSignup(db: Db, config: WebAuthnConfig, body: Record<string, unknown>, clock: Clock) {
  const name = cleanName(body.name);
  if (!name) throw new RequestError(400, 'Pick a name of 1 to 24 characters.');
  const timeZone = body.timeZone ?? DEFAULT_TIME_ZONE;
  if (!isValidTimeZone(timeZone)) throw new RequestError(400, 'timeZone must be an IANA time zone name.');
  const { dailyGoalReps } = body;
  if (dailyGoalReps !== undefined && !(Number.isInteger(dailyGoalReps) && (dailyGoalReps as number) >= MIN_DAILY_GOAL_REPS && (dailyGoalReps as number) <= MAX_DAILY_GOAL_REPS)) throw new RequestError(400, 'dailyGoalReps must be a whole number of reps.');
  let linkCodeHash: string | undefined;
  if (body.linkCode !== undefined) {
    if (!isPlausibleSecret(body.linkCode) || !(await liveLink(db, hashToken(body.linkCode), clock))) throw new RequestError(404, 'This link has expired or was replaced.');
    linkCodeHash = hashToken(body.linkCode);
  }
  const userId = newUserId();
  const challenge = await issueChallenge(db, { purpose: 'signup', userId, name, timeZone, ...(dailyGoalReps !== undefined ? { dailyGoalReps: dailyGoalReps as number } : {}), ...(linkCodeHash ? { linkCodeHash } : {}) }, clock);
  return registrationOptions(config, userId, name, challenge);
}

/**
 * Verifies the new passkey, then writes the account, the passkey and this device's token
 * together, with the friendship when it came through a link. A link that died in the
 * meantime doesn't stop the sign-up; the account is just made without it.
 */
export async function finishSignup(db: Db, config: WebAuthnConfig, body: Record<string, unknown>, clock: Clock): Promise<SignupResponse> {
  const { credential, challenge, pending } = await takeChallengeFor(db, body.credential, 'signup', clock);
  const passkey = await verifyNewPasskey(config, credential, challenge, body.label, clock);
  // No clock on the goal: set at sign-up, it loses to any edit.
  const user: User = { id: pending.userId!, name: pending.name!, createdAt: clock.now(), timeZone: pending.timeZone!, ...(pending.dailyGoalReps !== undefined ? { dailyGoalReps: pending.dailyGoalReps } : {}) };
  const token = newSecret();
  const account: NewAccount = { user, passkey, tokenHash: hashToken(token), sweepDay: addDays(dayKey(clock.now(), 'UTC'), EMPTY_ACCOUNT_SWEEP_DAYS) };
  const viaLink = pending.linkCodeHash ? await liveLink(db, pending.linkCodeHash, clock) : null;
  if (viaLink) {
    user.joinedVia = { kind: viaLink.link.kind, linkCreatedBy: viaLink.creator.id };
    account.friendId = viaLink.creator.id;
  }
  await db.createAccount(account);
  if (!viaLink) return { token, account: accountOf(user) };
  await bumpLinkCounter(db, pending.linkCodeHash!, 'joinCount');
  return { token, account: accountOf(user), redeemed: { kind: viaLink.link.kind, friend: { id: viaLink.creator.id, name: viaLink.creator.name } } };
}

/** No allowCredentials: the device offers whichever passkey it has for the domain, so there's no username to type. */
export async function startLogin(db: Db, config: WebAuthnConfig, clock: Clock) {
  const challenge = await issueChallenge(db, { purpose: 'login' }, clock);
  return generateAuthenticationOptions({ rpID: config.rpId, challenge, timeout: CHALLENGE_TTL_MS, userVerification: 'required' });
}

/** Finds the passkey through the user handle (the user id), verifies the signature, and mints a token for this device. */
export async function finishLogin(db: Db, config: WebAuthnConfig, body: Record<string, unknown>, clock: Clock): Promise<SessionResponse> {
  const { credential, challenge } = await takeChallengeFor(db, body.credential, 'login', clock);
  const userId = credential.response.userHandle ? Buffer.from(credential.response.userHandle, 'base64url').toString('utf8') : '';
  const passkey = /^[A-Za-z0-9_-]{1,64}$/.test(userId) ? await db.getPasskey(userId, credential.id) : null;
  if (!passkey) throw new RequestError(401, "This passkey isn't for an account here.");
  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verification = await verifyAuthenticationResponse({
      response: credential as unknown as AuthenticationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: config.origins,
      expectedRPID: config.rpId,
      credential: { id: passkey.credentialId, publicKey: new Uint8Array(Buffer.from(passkey.publicKey, 'base64url')), counter: passkey.counter, transports: passkey.transports },
      requireUserVerification: true,
    });
  } catch {
    throw new RequestError(401, UNVERIFIED);
  }
  if (!verification.verified) throw new RequestError(401, UNVERIFIED);
  const user = await db.getUser(userId);
  if (!user) throw new RequestError(401, "This passkey isn't for an account here.");
  // Synced passkeys always report 0; a counter is only kept when the authenticator has one.
  if (verification.authenticationInfo.newCounter > passkey.counter) await db.putPasskey(userId, { ...passkey, counter: verification.authenticationInfo.newCounter });
  const token = newSecret();
  await db.putToken(hashToken(token), userId, clock.now());
  return { token, account: accountOf(user) };
}

/** Adds another passkey to a signed-in account, which is how an account made before passkeys gets its first. */
export async function startRegister(db: Db, config: WebAuthnConfig, userId: string, clock: Clock) {
  const user = await db.getUser(userId);
  if (!user) throw new RequestError(401, 'This account no longer exists.');
  const challenge = await issueChallenge(db, { purpose: 'register', userId }, clock);
  return registrationOptions(config, userId, user.name, challenge, await db.passkeysOf(userId));
}

export async function finishRegister(db: Db, config: WebAuthnConfig, userId: string, body: Record<string, unknown>, clock: Clock): Promise<{ passkeys: PasskeySummary[] }> {
  const { credential, challenge, pending } = await takeChallengeFor(db, body.credential, 'register', clock);
  if (pending.userId !== userId) throw new RequestError(400, STALE_CHALLENGE);
  const passkey = await verifyNewPasskey(config, credential, challenge, body.label, clock);
  try {
    await db.addPasskey(userId, passkey);
  } catch (error) {
    if (!(error instanceof PreconditionFailed)) throw error;
  }
  return { passkeys: await listPasskeys(db, userId) };
}

export async function listPasskeys(db: Db, userId: string): Promise<PasskeySummary[]> {
  return (await db.passkeysOf(userId)).sort((a, b) => a.createdAt - b.createdAt).map(({ credentialId, label, createdAt }) => (label ? { credentialId, label, createdAt } : { credentialId, createdAt }));
}
