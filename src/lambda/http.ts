import { type Entry, type InviteRequest, MAX_PUSHED_ENTRIES, isValidEntry } from '../shared/model';
import { createInvite, redeemInvite } from './accounts';
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
    '/api/join': async (body) => {
      if (!isPlausibleSecret(body.code)) return errorResponse(400, 'That is not an invite link.');
      const redeemed = await redeemInvite(deps.db, body.code, body.name, clockFrom(deps));
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
  const { pushedEntries, sinceCursor } = body;
  if (!Array.isArray(pushedEntries) || pushedEntries.length > MAX_PUSHED_ENTRIES || !pushedEntries.every(isValidEntry)) {
    return errorResponse(400, `pushedEntries must be an array of at most ${MAX_PUSHED_ENTRIES} valid entries`);
  }
  if (!Number.isSafeInteger(sinceCursor) || (sinceCursor as number) < 0) return errorResponse(400, 'sinceCursor must be a non-negative integer');
  const user = await deps.db.getUser(userId);
  if (!user) return errorResponse(401, 'This account no longer exists.');
  const synced = await syncEntries(deps.db, userId, pushedEntries as Entry[], sinceCursor as number, clockFrom(deps));
  return { status: 200, body: { ...synced, account: { id: user.id, name: user.name } } };
}
