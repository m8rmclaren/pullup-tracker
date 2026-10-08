import type { InviteKind, InviteResponse, JoinRequest, JoinResponse, SyncRequest, SyncResponse } from '../shared/model';
import { HttpError, type Transport } from './tracker';

const TIMEOUT_MS = 15_000;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function post<T>(path: string, payload: unknown, token?: string): Promise<T> {
  const body = JSON.stringify(payload);
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      // CloudFront's origin access control signs requests to the Lambda URL with SigV4,
      // and for a request with a body it requires the viewer to supply the payload hash.
      'x-amz-content-sha256': await sha256Hex(body),
    };
    if (token) headers['x-pullup-token'] = token;
    const response = await fetch(path, { method: 'POST', headers, body, signal: abortController.signal, cache: 'no-store' });
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        message = ((await response.json()) as { error?: string }).error ?? message;
      } catch {}
      throw new HttpError(response.status, message);
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new Error('Request timed out');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export const fetchTransport: Transport = (request: SyncRequest, token: string) => post<SyncResponse>('/api/sync', request, token);

export const join = (request: JoinRequest) => post<JoinResponse>('/api/join', request);

export const createInvite = (kind: InviteKind, token: string) => post<InviteResponse>('/api/invite', { kind }, token);

/** The link a recipient opens. The kind rides in the fragment so the join screen knows whether to ask for a name. */
export const inviteLink = (kind: InviteKind, code: string) => `${location.origin}/#${kind === 'friend' ? 'join' : 'device'}=${code}`;

/** Reads an invite out of a link (or a bare fragment); null if it isn't one. */
export function parseInviteLink(text: string): { kind: InviteKind; code: string } | null {
  const match = /#(join|device)=([A-Za-z0-9_-]{16,256})\s*$/.exec(text.trim());
  return match ? { kind: match[1] === 'join' ? 'friend' : 'device', code: match[2]! } : null;
}
