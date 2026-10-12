import { createHash, randomBytes } from 'node:crypto';

/** Tokens and invite codes are stored only as this digest, so a leaked table grants nothing. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 256 random bits, URL-safe; used for device tokens and invite codes. */
export function newSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** 128 random bits, URL-safe: shorter than a token for links people share, still unguessable, which matters because redeeming one makes a friendship. */
export function newLinkCode(): string {
  return randomBytes(16).toString('base64url');
}

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** 16 lowercase base32 characters (80 bits), the shape of created ids: `x-` exercises, `v-` variations, `g-` challenges. */
export function newDefinitionSuffix(): string {
  return [...randomBytes(16)].map((byte) => BASE32_ALPHABET[byte & 31]).join('');
}

export function newUserId(): string {
  return randomBytes(9).toString('base64url');
}

/** Rejects junk before it costs a database read. */
export function isPlausibleSecret(secret: unknown): secret is string {
  return typeof secret === 'string' && secret.length >= 16 && secret.length <= 256 && /^[A-Za-z0-9_-]+$/.test(secret);
}
