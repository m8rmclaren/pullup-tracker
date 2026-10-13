import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { bedrockComposer } from './bedrock';
import type { ComposeConfig } from './compose';
import { DynamoDb } from './dynamodb';
import { route } from './http';
import type { WebAuthnConfig } from './passkeys';
import { type SweepResult, sweepEmptyAccounts } from './sweep';

// Lambda Function URL (payload v2) shapes, narrowed to what is read here.
interface FunctionUrlEvent {
  rawPath: string;
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: { http: { method: string } };
}

const db = new DynamoDb(DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }), process.env.TABLE!);
// Set from the custom domain in infra/main.tf; without one, passkeys stay off rather than bind to a cloudfront.net name.
const webAuthn: WebAuthnConfig | undefined = process.env.RP_ID && process.env.APP_ORIGIN ? { rpId: process.env.RP_ID, rpName: 'Pull-ups', origins: [process.env.APP_ORIGIN] } : undefined;
const isSignupOpen = process.env.SIGNUP_OPEN === 'true';
// Set in infra/main.tf when compose_enabled; without a model id, /api/compose answers 503.
const composeConfig: ComposeConfig | undefined = process.env.COMPOSE_MODEL_ID
  ? {
      composer: bedrockComposer({ region: process.env.AWS_REGION!, modelId: process.env.COMPOSE_MODEL_ID }),
      monthlyCeilingUsd: Number(process.env.COMPOSE_MONTHLY_CEILING_USD ?? '5'),
      inputUsdPerMillionTokens: Number(process.env.COMPOSE_INPUT_USD_PER_MTOK ?? '0.10'),
      outputUsdPerMillionTokens: Number(process.env.COMPOSE_OUTPUT_USD_PER_MTOK ?? '0.50'),
    }
  : undefined;

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

/** The daily EventBridge rule invokes the function directly with this input; it never arrives through the Function URL. */
interface SweepEvent {
  task: 'sweep';
}

interface FunctionUrlResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export async function handler(event: FunctionUrlEvent): Promise<FunctionUrlResponse>;
export async function handler(event: SweepEvent): Promise<SweepResult>;
export async function handler(event: FunctionUrlEvent | SweepEvent): Promise<FunctionUrlResponse | SweepResult> {
  if ('task' in event) {
    const result = await sweepEmptyAccounts(db, { now: Date.now });
    console.log(`swept empty accounts: deleted ${result.deleted}, kept ${result.kept}, left ${result.remaining} for the next run`);
    return result;
  }
  const body = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : '';
  try {
    const response = await route({ method: event.requestContext.http.method, path: event.rawPath, headers: event.headers ?? {}, body }, { db, userIdForToken, webAuthn, isSignupOpen, compose: composeConfig });
    return { statusCode: response.status, headers: JSON_HEADERS, body: JSON.stringify(response.body) };
  } catch (error) {
    console.error('request failed', event.rawPath, error);
    return { statusCode: 500, headers: JSON_HEADERS, body: '{"error":"internal"}' };
  }
}
