import { S3Client } from '@aws-sdk/client-s3';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { parseHashList } from './auth';
import { route } from './http';
import { S3Store } from './s3store';

// Lambda Function URL (payload v2) shapes, narrowed to what is read here.
interface UrlEvent {
  rawPath: string;
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: { http: { method: string } };
}

const store = new S3Store(new S3Client({}), process.env.DATA_BUCKET!);
const ssm = new SSMClient({});
const CACHE_MS = 60_000;
let cached: { at: number; hashes: string[] } | null = null;

// Cached briefly so a rotation takes effect within a minute without a redeploy.
async function tokenHashes(): Promise<string[]> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.hashes;
  const res = await ssm.send(new GetParameterCommand({ Name: process.env.TOKEN_PARAM!, WithDecryption: true }));
  cached = { at: Date.now(), hashes: parseHashList(res.Parameter?.Value ?? '') };
  return cached.hashes;
}

export async function handler(event: UrlEvent) {
  const body = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : '';
  try {
    const res = await route(
      { method: event.requestContext.http.method, path: event.rawPath, headers: event.headers ?? {}, body },
      { store, tokenHashes },
    );
    return {
      statusCode: res.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: JSON.stringify(res.body),
    };
  } catch (err) {
    console.error('sync failed', err);
    return { statusCode: 500, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: '{"error":"internal"}' };
  }
}
