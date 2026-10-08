import { createHash, timingSafeEqual } from 'node:crypto';

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** `validHashes` are hex SHA-256 digests; more than one is valid at once during a rotation. */
export function tokenMatches(token: string | undefined, validHashes: string[]): boolean {
  if (!token || token.length < 16 || token.length > 256) return false;
  const got = Buffer.from(hashToken(token), 'hex');
  let ok = false;
  for (const h of validHashes) {
    const want = Buffer.from(h, 'hex');
    if (want.length === got.length && timingSafeEqual(want, got)) ok = true;
  }
  return ok;
}

export function parseHashList(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[0-9a-f]{64}$/.test(s));
}
