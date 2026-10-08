import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoDb } from './dynamodb';
import { route } from './http';

// Lambda Function URL (payload v2) shapes, narrowed to what is read here.
interface FunctionUrlEvent {
  rawPath: string;
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: { http: { method: string } };
}

const db = new DynamoDb(DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }), process.env.TABLE!);

// Cached briefly so a sync doesn't pay a read for auth; a revoked token stops working within a minute.
const TOKEN_CACHE_TTL_MS = 60_000;
const MAX_CACHED_TOKENS = 1000;
const tokenCache = new Map<string, { cachedAtMs: number; userId: string | null }>();

async function userIdForToken(tokenHash: string): Promise<string | null> {
  const cached = tokenCache.get(tokenHash);
  if (cached && Date.now() - cached.cachedAtMs < TOKEN_CACHE_TTL_MS) return cached.userId;
  const userId = await db.userIdForToken(tokenHash);
  if (tokenCache.size >= MAX_CACHED_TOKENS) tokenCache.clear();
  // Misses aren't cached: a device that just redeemed an invite must work on its next request.
  if (userId) tokenCache.set(tokenHash, { cachedAtMs: Date.now(), userId });
  return userId;
}

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

export async function handler(event: FunctionUrlEvent) {
  const body = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : '';
  try {
    const response = await route({ method: event.requestContext.http.method, path: event.rawPath, headers: event.headers ?? {}, body }, { db, userIdForToken });
    return { statusCode: response.status, headers: JSON_HEADERS, body: JSON.stringify(response.body) };
  } catch (error) {
    console.error('request failed', event.rawPath, error);
    return { statusCode: 500, headers: JSON_HEADERS, body: '{"error":"internal"}' };
  }
}
