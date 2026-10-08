import { type SyncRequest, MAX_PUSH, isValidEntry } from '../shared/model';
import { tokenMatches } from './auth';
import { handleSync } from './sync';
import type { ObjectStore } from './store';

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
  store: ObjectStore;
  tokenHashes: () => Promise<string[]>;
}

export async function route(req: HttpRequest, deps: Deps): Promise<HttpResponse> {
  if (req.path !== '/api/sync') return { status: 404, body: { error: 'not found' } };
  if (req.method !== 'POST') return { status: 405, body: { error: 'method not allowed' } };
  if (!tokenMatches(req.headers['x-pullup-token'], await deps.tokenHashes())) {
    return { status: 401, body: { error: 'bad token' } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body);
  } catch {
    return { status: 400, body: { error: 'body is not JSON' } };
  }
  const r = parsed as Partial<SyncRequest>;
  if (!Array.isArray(r.push) || r.push.length > MAX_PUSH || !r.push.every(isValidEntry)) {
    return { status: 400, body: { error: `push must be an array of at most ${MAX_PUSH} valid entries` } };
  }
  const have: Record<string, string> = {};
  if (r.have && typeof r.have === 'object') {
    for (const [k, v] of Object.entries(r.have)) if (/^\d{4}-\d{2}$/.test(k) && typeof v === 'string') have[k] = v;
  }
  return { status: 200, body: await handleSync(deps.store, { push: r.push, have }) };
}
