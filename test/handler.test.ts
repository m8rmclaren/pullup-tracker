import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { MemoryStore } from '../src/lambda/store';

const TOKEN = 'handler-test-token-abcdefghijkl';
const ssmCalls = vi.fn();

vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class {
    send = async (cmd: unknown) => {
      ssmCalls(cmd);
      return { Parameter: { Value: `unset-junk, ${createHash('sha256').update(TOKEN).digest('hex')}` } };
    };
  },
  GetParameterCommand: class {
    constructor(readonly input: unknown) {}
  },
}));
vi.mock('../src/lambda/s3store', () => ({ S3Store: MemoryStore }));

let handler: typeof import('../src/lambda/handler').handler;
beforeAll(async () => {
  process.env.DATA_BUCKET = 'b';
  process.env.TOKEN_PARAM = '/p';
  ({ handler } = await import('../src/lambda/handler'));
});

const event = (body: string, token = TOKEN, b64 = false) => ({
  rawPath: '/api/sync',
  headers: { 'x-pullup-token': token },
  body: b64 ? Buffer.from(body).toString('base64') : body,
  isBase64Encoded: b64,
  requestContext: { http: { method: 'POST' } },
});

describe('lambda handler', () => {
  it('decodes base64 bodies, authenticates against SSM, and caches the hash list', async () => {
    const push = [{ id: 'a1', ts: Date.parse('2026-10-08T18:00:00Z'), reps: 6, updatedAt: 1 }];
    const res = await handler(event(JSON.stringify({ push, have: {} }), TOKEN, true));
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(res.body).months['2026-10'].entries).toEqual(push);

    expect((await handler(event('{"push":[],"have":{}}', 'wrong-token-but-long-enough'))).statusCode).toBe(401);
    expect(ssmCalls).toHaveBeenCalledTimes(1);
  });
});
