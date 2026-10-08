import { type Entry, type InviteRequest, MAX_PUSH, isValidEntry } from '../shared/model';
import { createInvite, redeemInvite } from './accounts';
import { hashToken, plausibleSecret } from './auth';
import type { Db } from './db';
import { type Clock, handleSync } from './sync';

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

export interface Deps {
  db: Db;
  /** Defaults to db.userIdForToken; the Lambda wraps it in a short cache. */
  userIdForToken?: (tokenHash: string) => Promise<string | null>;
  clock?: Clock;
}

const err = (status: number, error: string): HttpResponse => ({ status, body: { error } });

export async function route(req: HttpRequest, deps: Deps): Promise<HttpResponse> {
  const handlers: Record<string, (body: Record<string, unknown>) => Promise<HttpResponse>> = {
    '/api/sync': async (body) => {
      const uid = await authenticate(req, deps);
      if (!uid) return err(401, 'This device is signed out.');
      return sync(uid, body, deps);
    },
    '/api/invite': async (body) => {
      const uid = await authenticate(req, deps);
      if (!uid) return err(401, 'This device is signed out.');
      const kind = (body as Partial<InviteRequest>).kind;
      if (kind !== 'friend' && kind !== 'device') return err(400, 'kind must be friend or device');
      return { status: 200, body: await createInvite(deps.db, uid, kind, clockOf(deps)) };
    },
    '/api/join': async (body) => {
      if (!plausibleSecret(body.code)) return err(400, 'That is not an invite link.');
      const r = await redeemInvite(deps.db, body.code, body.name, clockOf(deps));
      return r.ok ? { status: 200, body: { token: r.token, me: r.me } } : err(r.status, r.error);
    },
  };

  const handler = handlers[req.path];
  if (!handler) return err(404, 'not found');
  if (req.method !== 'POST') return err(405, 'method not allowed');
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body);
  } catch {
    return err(400, 'body is not JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return err(400, 'body must be a JSON object');
  return handler(parsed as Record<string, unknown>);
}

const clockOf = (deps: Deps): Clock => deps.clock ?? { now: Date.now };

async function authenticate(req: HttpRequest, deps: Deps): Promise<string | null> {
  const token = req.headers['x-pullup-token'];
  if (!plausibleSecret(token)) return null;
  const lookup = deps.userIdForToken ?? ((h: string) => deps.db.userIdForToken(h));
  return lookup(hashToken(token));
}

async function sync(uid: string, body: Record<string, unknown>, deps: Deps): Promise<HttpResponse> {
  const { push, since } = body;
  if (!Array.isArray(push) || push.length > MAX_PUSH || !push.every(isValidEntry)) {
    return err(400, `push must be an array of at most ${MAX_PUSH} valid entries`);
  }
  if (!Number.isSafeInteger(since) || (since as number) < 0) return err(400, 'since must be a non-negative integer');
  const user = await deps.db.getUser(uid);
  if (!user) return err(401, 'This account no longer exists.');
  const res = await handleSync(deps.db, uid, push as Entry[], since as number, clockOf(deps));
  return { status: 200, body: { ...res, me: { id: user.id, name: user.name } } };
}
