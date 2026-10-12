import { type Entry, type InviteRequest, MAX_PUSHED_ENTRIES, PROTOCOL_VERSION, isValidEntry } from '../shared/model';
import { isValidProfilePatch } from '../shared/profile';
import { type Definition, MAX_PUSHED_DEFINITIONS, isValidDefinition } from '../shared/definitions';
import { createInvite, redeemInvite } from './accounts';
import { definitionsForSync, findMeasureMismatch, mergePushedDefinitions } from './definitions';
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
}

const errorResponse = (status: number, error: string): HttpResponse => ({ status, body: { error } });

export async function route(request: HttpRequest, deps: RouteDeps): Promise<HttpResponse> {
  const handlers: Record<string, (body: Record<string, unknown>) => Promise<HttpResponse>> = {
    '/api/sync': async (body) => {
      if (body.protocolVersion !== PROTOCOL_VERSION) return { status: 426, body: { error: 'Update the app to keep syncing.', protocolVersion: PROTOCOL_VERSION } };
      const userId = await authenticate(request, deps);
      if (!userId) return errorResponse(401, 'This device is signed out.');
      return sync(userId, body, deps);
    },
    '/api/invite': async (body) => {
      const userId = await authenticate(request, deps);
      if (!userId) return errorResponse(401, 'This device is signed out.');
      const kind = (body as Partial<InviteRequest>).kind;
      if (kind !== 'friend' && kind !== 'device') return errorResponse(400, 'kind must be friend or device');
      return { status: 200, body: await createInvite(deps.db, userId, kind, clockFrom(deps)) };
    },
    '/api/profile': async (body) => {
      const userId = await authenticate(request, deps);
      if (!userId) return errorResponse(401, 'This device is signed out.');
      if (!isValidProfilePatch(body)) return errorResponse(400, 'Each of name, timeZone and dailyGoalReps needs its updatedAt clock, and a valid value.');
      const user = await updateProfile(deps.db, userId, body, clockFrom(deps));
      return user ? { status: 200, body: accountOf(user) } : errorResponse(401, 'This account no longer exists.');
    },
    '/api/join': async (body) => {
      if (!isPlausibleSecret(body.code)) return errorResponse(400, 'That is not an invite link.');
      const redeemed = await redeemInvite(deps.db, body.code, body.name, body.timeZone, clockFrom(deps));
      return redeemed.ok ? { status: 200, body: { token: redeemed.token, account: redeemed.account } } : errorResponse(redeemed.status, redeemed.error);
    },
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
  return handler(parsed as Record<string, unknown>);
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
  const definitions = await definitionsForSync(deps.db, userId, pushedEntries as Entry[], synced.entries, clock);
  return { status: 200, body: { ...synced, definitions, account } };
}
