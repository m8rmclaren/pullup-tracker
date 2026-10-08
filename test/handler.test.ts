import { beforeAll, describe, expect, it, vi } from 'vitest';
import { hashToken } from '../src/lambda/auth';

const TOKEN = 'handler-test-token-abcdefghijkl';
const { memoryDb } = await vi.hoisted(async () => {
  const { MemoryDb } = await import('../src/lambda/db');
  return { memoryDb: new MemoryDb() };
});
vi.mock('../src/lambda/dynamodb', () => ({
  DynamoDb: function () {
    return memoryDb;
  },
}));

let handler: typeof import('../src/lambda/handler').handler;
beforeAll(async () => {
  process.env.TABLE = 't';
  memoryDb.users.set('u1', { id: 'u1', name: 'One', createdAt: 1 });
  memoryDb.tokens.set(hashToken(TOKEN), 'u1');
  ({ handler } = await import('../src/lambda/handler'));
});

const event = (body: string, token = TOKEN, isBase64Encoded = false) => ({
  rawPath: '/api/sync',
  headers: { 'x-pullup-token': token },
  body: isBase64Encoded ? Buffer.from(body).toString('base64') : body,
  isBase64Encoded,
  requestContext: { http: { method: 'POST' } },
});

describe('lambda handler', () => {
  it('decodes base64 bodies, authenticates, and caches the token lookup', async () => {
    const lookups = vi.spyOn(memoryDb, 'userIdForToken');
    const pushedEntries = [{ id: 'a1', doneAt: Date.parse('2026-10-08T18:00:00Z'), reps: 6, updatedAt: 1 }];
    const response = await handler(event(JSON.stringify({ pushedEntries, sinceCursor: 0 }), TOKEN, true));
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(response.body).entries).toEqual(pushedEntries);

    expect((await handler(event('{"pushedEntries":[],"sinceCursor":0}'))).statusCode).toBe(200);
    expect(lookups).toHaveBeenCalledTimes(1);
    expect((await handler(event('{"pushedEntries":[],"sinceCursor":0}', 'wrong-token-but-long-enough'))).statusCode).toBe(401);
  });

  it('answers 500 without leaking the error', async () => {
    vi.spyOn(memoryDb, 'getUser').mockRejectedValueOnce(new Error('boom: internal detail'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await handler(event('{"pushedEntries":[],"sinceCursor":0}'));
    expect(response).toMatchObject({ statusCode: 500, body: '{"error":"internal"}' });
  });
});
