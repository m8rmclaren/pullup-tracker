import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { DynamoDb } from './dynamodb';
import { route } from './http';

// Lambda Function URL (payload v2) shapes, narrowed to what is read here.
interface UrlEvent {
  rawPath: string;
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: { http: { method: string } };
}

const db = new DynamoDb(DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }), process.env.TABLE!);

// Cached briefly so a sync doesn't pay a read for auth; a revoked token stops working within a minute.
const CACHE_MS = 60_000;
const MAX_CACHED = 1000;
const tokenCache = new Map<string, { at: number; uid: string | null }>();

async function userIdForToken(tokenHash: string): Promise<string | null> {
  const hit = tokenCache.get(tokenHash);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.uid;
  const uid = await db.userIdForToken(tokenHash);
  if (tokenCache.size >= MAX_CACHED) tokenCache.clear();
  // Misses aren't cached: a device that just redeemed an invite must work on its next request.
  if (uid) tokenCache.set(tokenHash, { at: Date.now(), uid });
  return uid;
}

const JSON_HEADERS = { 'content-type': 'application/json', 'cache-control': 'no-store' };

export async function handler(event: UrlEvent) {
  const body = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : '';
  try {
    const res = await route({ method: event.requestContext.http.method, path: event.rawPath, headers: event.headers ?? {}, body }, { db, userIdForToken });
    return { statusCode: res.status, headers: JSON_HEADERS, body: JSON.stringify(res.body) };
  } catch (err) {
    console.error('request failed', event.rawPath, err);
    return { statusCode: 500, headers: JSON_HEADERS, body: '{"error":"internal"}' };
  }
}
