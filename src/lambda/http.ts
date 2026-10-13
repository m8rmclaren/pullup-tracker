import { type Entry, MAX_PUSHED_ENTRIES, PROTOCOL_VERSION, isValidEntry } from '../shared/model';
import { isValidProfilePatch } from '../shared/profile';
import { type Definition, MAX_PUSHED_DEFINITIONS, isValidDefinition } from '../shared/definitions';
import { createDeviceLink, redeemDeviceLink } from './accounts';
import { leaderboard, viewProfile } from './boards';
import { type ComposeConfig, compose } from './compose';
import { adoptFriendsExercise, definitionsForSync, findMeasureMismatch, mergePushedDefinitions } from './definitions';
import { RequestError } from './errors';
import { friendsResponse, rotateFriendLink } from './friends';
import { challengeBoard, challengeLink, createChallenge, leaveChallenge, listChallenges } from './challenges';
import { redeemLink, resolveLink } from './redeem';
import { cancelRequest, incomingRequestsFor, respondToRequest, sendRequest, suggestions } from './requests';
import { type WebAuthnConfig, finishLogin, finishRegister, finishSignup, listPasskeys, startLogin, startRegister, startSignup } from './passkeys';
import { accountOf, updateProfile } from './profile';
import { hashToken, isPlausibleSecret } from './auth';
import type { Db } from './db';
import { type Clock, syncEntries } from './sync';

export interface HttpRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: string;
}

export interface HttpResponse {
  status: number;
  body: unknown;
}

export interface RouteDeps {
  db: Db;
  /** Defaults to db.userIdForToken; the Lambda wraps it in a short cache. */
  userIdForToken?: (tokenHash: string) => Promise<string | null>;
  clock?: Clock;
  /** Absent where no domain is configured: passkeys are bound to one, so they are off. */
  webAuthn?: WebAuthnConfig;
  /** New accounts can be made only when this is true. Signing in and adding passkeys work either way. */
  isSignupOpen?: boolean;
  /** Absent where no model is configured: /api/compose answers 503 and the pad is the way in. */
  compose?: ComposeConfig;
}

type Handler = (body: Record<string, unknown>) => Promise<HttpResponse>;

const errorResponse = (status: number, error: string): HttpResponse => ({ status, body: { error } });
const ok = (body: unknown): HttpResponse => ({ status: 200, body });

export async function route(request: HttpRequest, deps: RouteDeps): Promise<HttpResponse> {
  const clock = clockFrom(deps);
  const signedIn =
    (handle: (userId: string, body: Record<string, unknown>) => Promise<HttpResponse>): Handler =>
    async (body) => {
      const userId = await authenticate(request, deps);
      return userId ? handle(userId, body) : errorResponse(401, 'This device is signed out.');
    };
  const webAuthn = (): WebAuthnConfig => {
    if (!deps.webAuthn) throw new RequestError(503, "Passkeys aren't set up on this server.");
    return deps.webAuthn;
  };
  const signupOpen = () => {
    if (!deps.isSignupOpen) throw new RequestError(403, "Sign-up isn't open yet.");
  };

  const handlers: Record<string, Handler> = {
    '/api/sync': async (body) => {
      if (body.protocolVersion !== PROTOCOL_VERSION) return { status: 426, body: { error: 'Update the app to keep syncing.', protocolVersion: PROTOCOL_VERSION } };
      return signedIn((userId) => sync(userId, body, deps))(body);
    },
    '/api/invite': signedIn(async (userId, body) => {
      if (body.kind !== 'device') return errorResponse(400, 'kind must be device');
      return ok(await createDeviceLink(deps.db, userId, clock));
    }),
    '/api/profile': signedIn(async (userId, body) => {
      if (!isValidProfilePatch(body)) return errorResponse(400, 'Each of name, timeZone and dailyGoalReps needs its updatedAt clock, and a valid value.');
      const user = await updateProfile(deps.db, userId, body, clock);
      return user ? ok(accountOf(user)) : errorResponse(401, 'This account no longer exists.');
    }),
    '/api/join': async (body) => {
      if (!isPlausibleSecret(body.code)) return errorResponse(400, 'That is not a device link.');
      return ok(await redeemDeviceLink(deps.db, body.code, clock));
    },
    '/api/signup/options': async (body) => {
      signupOpen();
      return ok(await startSignup(deps.db, webAuthn(), body, clock));
    },
    '/api/signup': async (body) => {
      signupOpen();
      return ok(await finishSignup(deps.db, webAuthn(), body, clock));
    },
    '/api/passkey/login/options': async () => ok(await startLogin(deps.db, webAuthn(), clock)),
    '/api/passkey/login': async (body) => ok(await finishLogin(deps.db, webAuthn(), body, clock)),
    '/api/passkey/register/options': signedIn(async (userId) => ok(await startRegister(deps.db, webAuthn(), userId, clock))),
    '/api/passkey/register': signedIn(async (userId, body) => ok(await finishRegister(deps.db, webAuthn(), userId, body, clock))),
    '/api/passkey/list': signedIn(async (userId) => ok({ passkeys: await listPasskeys(deps.db, userId) })),
    '/api/friends': signedIn(async (userId) => ok(await friendsResponse(deps.db, userId, clock))),
    '/api/friends/remove': signedIn(async (userId, body) => {
      if (typeof body.friendId !== 'string' || !body.friendId) return errorResponse(400, 'friendId must be a user id');
      await deps.db.unfriend(userId, body.friendId);
      return ok({});
    }),
    '/api/friends/request': signedIn(async (userId, body) => ok(await sendRequest(deps.db, userId, body, clock))),
    '/api/friends/respond': signedIn(async (userId, body) => ok(await respondToRequest(deps.db, userId, body, clock))),
    '/api/friends/cancel': signedIn(async (userId, body) => ok(await cancelRequest(deps.db, userId, body))),
    '/api/friends/suggestions': signedIn(async (userId) => ok({ suggestions: await suggestions(deps.db, userId) })),
    '/api/friends/rotate-link': signedIn(async (userId) => ok({ friendLink: await rotateFriendLink(deps.db, userId, clock) })),
    '/api/challenges/create': signedIn(async (userId, body) => ok(await createChallenge(deps.db, userId, body, clock))),
    '/api/challenges/list': signedIn(async (userId) => ok({ challenges: await listChallenges(deps.db, userId, clock) })),
    '/api/challenges/link': signedIn(async (userId, body) => ok(await challengeLink(deps.db, userId, body.challengeId))),
    '/api/challenges/leave': signedIn(async (userId, body) => ok(await leaveChallenge(deps.db, userId, body.challengeId))),
    '/api/challenges/board': signedIn(async (userId, body) => ok(await challengeBoard(deps.db, userId, body.challengeId))),
    '/api/leaderboard': signedIn(async (userId, body) => ok(await leaderboard(deps.db, userId, body))),
    '/api/profile/view': signedIn(async (userId, body) => ok(await viewProfile(deps.db, userId, body, clock))),
    '/api/compose': signedIn(async (userId, body) => ok(await compose(deps.db, userId, body, deps.compose, clock))),
    '/api/exercises/adopt': signedIn(async (userId, body) => ok(await adoptFriendsExercise(deps.db, userId, body, clock))),
    '/api/links/resolve': async (body) => {
      if (!isPlausibleSecret(body.code)) return errorResponse(404, 'This link has expired or was replaced.');
      return ok(await resolveLink(deps.db, body.code, clock));
    },
    '/api/links/redeem': signedIn(async (userId, body) => {
      if (!isPlausibleSecret(body.code)) return errorResponse(404, 'This link has expired or was replaced.');
      return ok(await redeemLink(deps.db, userId, body.code, clock));
    }),
  };

  const handler = handlers[request.path];
  if (!handler) return errorResponse(404, 'not found');
  if (request.method !== 'POST') return errorResponse(405, 'method not allowed');
  let parsed: unknown;
  try {
    parsed = JSON.parse(request.body);
  } catch {
    return errorResponse(400, 'body is not JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return errorResponse(400, 'body must be a JSON object');
  try {
    return await handler(parsed as Record<string, unknown>);
  } catch (error) {
    if (error instanceof RequestError) return errorResponse(error.status, error.message);
    throw error;
  }
}

const clockFrom = (deps: RouteDeps): Clock => deps.clock ?? { now: Date.now };

async function authenticate(request: HttpRequest, deps: RouteDeps): Promise<string | null> {
  const token = request.headers['x-pullup-token'];
  if (!isPlausibleSecret(token)) return null;
  const lookup = deps.userIdForToken ?? ((tokenHash: string) => deps.db.userIdForToken(tokenHash));
  return lookup(hashToken(token));
}

async function sync(userId: string, body: Record<string, unknown>, deps: RouteDeps): Promise<HttpResponse> {
  const { pushedEntries, sinceCursor, pushedDefinitions = [] } = body;
  if (!Array.isArray(pushedEntries) || pushedEntries.length > MAX_PUSHED_ENTRIES || !pushedEntries.every(isValidEntry)) {
    return errorResponse(400, `pushedEntries must be an array of at most ${MAX_PUSHED_ENTRIES} valid entries`);
  }
  if (!Array.isArray(pushedDefinitions) || pushedDefinitions.length > MAX_PUSHED_DEFINITIONS || !pushedDefinitions.every(isValidDefinition)) {
    return errorResponse(400, `pushedDefinitions must be an array of at most ${MAX_PUSHED_DEFINITIONS} valid definitions`);
  }
  if (!Number.isSafeInteger(sinceCursor) || (sinceCursor as number) < 0) return errorResponse(400, 'sinceCursor must be a non-negative integer');
  const user = await deps.db.getUser(userId);
  if (!user) return errorResponse(401, 'This account no longer exists.');
  const account = accountOf(user);
  const timeZone = account.timeZone!;
  const clock = clockFrom(deps);

  await mergePushedDefinitions(deps.db, userId, pushedDefinitions as Definition[], clock);
  const mismatched = await findMeasureMismatch(deps.db, pushedEntries as Entry[]);
  if (mismatched) return errorResponse(400, `entry ${mismatched.id} doesn't match its exercise's measure`);
  const synced = await syncEntries(deps.db, userId, timeZone, pushedEntries as Entry[], sinceCursor as number, clock);
  const [definitions, incomingRequests] = await Promise.all([definitionsForSync(deps.db, userId, pushedEntries as Entry[], synced.entries, clock), incomingRequestsFor(deps.db, userId)]);
  return { status: 200, body: { ...synced, definitions, account: { ...account, incomingRequests } } };
}
