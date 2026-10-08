import type { InviteKind, InviteResponse, JoinRequest, JoinResponse, SyncRequest, SyncResponse } from '../shared/model';
import { HttpError, type Transport } from './tracker';

const TIMEOUT_MS = 15_000;

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function post<T>(path: string, payload: unknown, token?: string): Promise<T> {
  const body = JSON.stringify(payload);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      // CloudFront's origin access control signs requests to the Lambda URL with SigV4,
      // and for a request with a body it requires the viewer to supply the payload hash.
      'x-amz-content-sha256': await sha256Hex(body),
    };
    if (token) headers['x-pullup-token'] = token;
    const res = await fetch(path, { method: 'POST', headers, body, signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        msg = ((await res.json()) as { error?: string }).error ?? msg;
      } catch {}
      throw new HttpError(res.status, msg);
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw new Error('Request timed out');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export const fetchTransport: Transport = (req: SyncRequest, token: string) => post<SyncResponse>('/api/sync', req, token);

export const join = (req: JoinRequest) => post<JoinResponse>('/api/join', req);

export const createInvite = (kind: InviteKind, token: string) => post<InviteResponse>('/api/invite', { kind }, token);

/** The link a recipient opens. The kind rides in the fragment so the join screen knows whether to ask for a name. */
export const inviteLink = (kind: InviteKind, code: string) => `${location.origin}/#${kind === 'friend' ? 'join' : 'device'}=${code}`;

/** Reads an invite out of a link (or a bare fragment); null if it isn't one. */
export function parseInviteLink(text: string): { kind: InviteKind; code: string } | null {
  const m = /#(join|device)=([A-Za-z0-9_-]{16,256})\s*$/.exec(text.trim());
  return m ? { kind: m[1] === 'join' ? 'friend' : 'device', code: m[2]! } : null;
}
