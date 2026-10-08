import { beforeAll, describe, expect, it, vi } from 'vitest';
import { hashToken } from '../src/lambda/auth';

const TOKEN = 'handler-test-token-abcdefghijkl';
const { mem } = await vi.hoisted(async () => {
  const { MemoryDb } = await import('../src/lambda/db');
  return { mem: new MemoryDb() };
});
vi.mock('../src/lambda/dynamodb', () => ({
  DynamoDb: function () {
    return mem;
  },
}));

let handler: typeof import('../src/lambda/handler').handler;
beforeAll(async () => {
  process.env.TABLE = 't';
  mem.users.set('u1', { id: 'u1', name: 'One', createdAt: 1 });
  mem.tokens.set(hashToken(TOKEN), 'u1');
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
  it('decodes base64 bodies, authenticates, and caches the token lookup', async () => {
    const lookups = vi.spyOn(mem, 'userIdForToken');
    const push = [{ id: 'a1', ts: Date.parse('2026-10-08T18:00:00Z'), reps: 6, updatedAt: 1 }];
    const res = await handler(event(JSON.stringify({ push, since: 0 }), TOKEN, true));
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(res.body).entries).toEqual(push);

    expect((await handler(event('{"push":[],"since":0}'))).statusCode).toBe(200);
    expect(lookups).toHaveBeenCalledTimes(1);
    expect((await handler(event('{"push":[],"since":0}', 'wrong-token-but-long-enough'))).statusCode).toBe(401);
  });

  it('answers 500 without leaking the error', async () => {
    vi.spyOn(mem, 'getUser').mockRejectedValueOnce(new Error('boom: internal detail'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await handler(event('{"push":[],"since":0}'));
    expect(res).toMatchObject({ statusCode: 500, body: '{"error":"internal"}' });
  });
});
