import type { SyncRequest, SyncResponse } from '../shared/model';
import { HttpError, type Transport } from './tracker';

const TIMEOUT_MS = 15_000;

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const fetchTransport: Transport = async (req: SyncRequest, token: string): Promise<SyncResponse> => {
  const body = JSON.stringify(req);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch('/api/sync', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-pullup-token': token,
        // CloudFront's origin access control signs requests to the Lambda URL with SigV4,
        // and for a request with a body it requires the viewer to supply the payload hash.
        'x-amz-content-sha256': await sha256Hex(body),
      },
      body,
      signal: ctrl.signal,
      cache: 'no-store',
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        msg = ((await res.json()) as { error?: string }).error ?? msg;
      } catch {}
      throw new HttpError(res.status, msg);
    }
    return (await res.json()) as SyncResponse;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw new Error('Request timed out');
    throw err;
  } finally {
    clearTimeout(timer);
  }
};
