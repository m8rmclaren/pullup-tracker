// Runs the DynamoDB adapter against a real DynamoDB (Local), since conditions, indexes and
// transactions are where a fake would agree with itself and be wrong:
//   docker run --rm -p 8000:8000 amazon/dynamodb-local
//   DYNAMODB_ENDPOINT=http://localhost:8000 npm test
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { redeemInvite } from '../src/lambda/accounts';
import { hashToken } from '../src/lambda/auth';
import { PreconditionFailed } from '../src/lambda/db';
import { DynamoDb } from '../src/lambda/dynamodb';
import { handleSync } from '../src/lambda/sync';
import type { Entry } from '../src/shared/model';

const endpoint = process.env.DYNAMODB_ENDPOINT;
const table = `pullups-test-${Date.now()}`;
const raw = new DynamoDBClient({ endpoint, region: 'us-west-2', credentials: { accessKeyId: 'x', secretAccessKey: 'x' } });
const doc = DynamoDBDocumentClient.from(raw, { marshallOptions: { removeUndefinedValues: true } });
const db = new DynamoDb(doc, table);

const OCT8 = Date.parse('2026-10-08T18:00:00Z');
let n = 0;
const e = (ts: number, reps = 5, extra: Partial<Entry> = {}): Entry => ({ id: `d${++n}`, ts, reps, updatedAt: 1, ...extra });

describe.skipIf(!endpoint)('DynamoDb', () => {
  beforeAll(async () => {
    // Mirrors aws_dynamodb_table.data in infra/main.tf.
    await raw.send(
      new CreateTableCommand({
        TableName: table,
        BillingMode: 'PAY_PER_REQUEST',
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'sk', AttributeType: 'S' },
          { AttributeName: 'srv', AttributeType: 'N' },
          { AttributeName: 'ts', AttributeType: 'N' },
          { AttributeName: 'mpk', AttributeType: 'S' },
          { AttributeName: 'msk', AttributeType: 'S' },
        ],
        LocalSecondaryIndexes: [
          { IndexName: 'by-srv', KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'srv', KeyType: 'RANGE' }], Projection: { ProjectionType: 'ALL' } },
          { IndexName: 'by-ts', KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'ts', KeyType: 'RANGE' }], Projection: { ProjectionType: 'ALL' } },
        ],
        GlobalSecondaryIndexes: [
          { IndexName: 'by-month', KeySchema: [{ AttributeName: 'mpk', KeyType: 'HASH' }, { AttributeName: 'msk', KeyType: 'RANGE' }], Projection: { ProjectionType: 'ALL' } },
        ],
      }),
    );
  });
  afterAll(async () => {
    await raw.send(new DeleteTableCommand({ TableName: table }));
  });

  it('enforces the entry and day preconditions', async () => {
    const a = { ...e(OCT8), srv: 10 };
    await db.putEntry('c1', a, null);
    await expect(db.putEntry('c1', { ...a, srv: 11 }, null)).rejects.toBeInstanceOf(PreconditionFailed);
    await expect(db.putEntry('c1', { ...a, srv: 11 }, 9)).rejects.toBeInstanceOf(PreconditionFailed);
    await db.putEntry('c1', { ...a, reps: 6, srv: 11 }, 10);
    expect((await db.getEntries('c1', [a.id, 'missing'])).get(a.id)).toEqual({ ...a, reps: 6, srv: 11 });

    await db.putDay('c1', { day: '2026-10-08', reps: 6, sets: 1, best: 6, ver: 1 }, null);
    await expect(db.putDay('c1', { day: '2026-10-08', reps: 0, sets: 0, best: 0, ver: 2 }, null)).rejects.toBeInstanceOf(PreconditionFailed);
    await db.putDay('c1', { day: '2026-10-08', reps: 9, sets: 2, best: 6, ver: 2 }, 1);
    expect(await db.getDay('c1', '2026-10-08')).toEqual({ day: '2026-10-08', reps: 9, sets: 2, best: 6, ver: 2 });
  });

  it('queries by write time and by set time, per user, across pages', async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ ...e(OCT8 + i, 5, { lbs: 2.5 }), srv: 1000 + i }));
    await Promise.all(many.map((x) => db.putEntry('q1', x, null)));
    await db.putEntry('q2', { ...e(OCT8), srv: 5000 }, null);
    expect(await db.entriesSince('q1', 1100)).toHaveLength(49);
    expect(await db.entriesBetween('q1', OCT8 + 10, OCT8 + 20)).toHaveLength(10);
    expect((await db.getEntries('q1', many.map((x) => x.id))).size).toBe(150);
    expect((await db.entriesSince('q1', 0))[0]!.lbs).toBe(2.5);
  });

  it('syncs concurrently without losing sets, and day totals land in the month index', async () => {
    const pushes = Array.from({ length: 10 }, (_, i) => [e(OCT8 + i * 1000, i + 1)]);
    await Promise.all(pushes.map((push) => handleSync(db, 's1', push, 0)));
    expect((await handleSync(db, 's1', [], 0)).entries).toHaveLength(10);
    expect(await db.getDay('s1', '2026-10-08')).toMatchObject({ reps: 55, sets: 10, best: 10 });

    const board = await doc.send(new QueryCommand({ TableName: table, IndexName: 'by-month', KeyConditionExpression: 'mpk = :m', ExpressionAttributeValues: { ':m': 'M#2026-10' } }));
    expect(board.Items?.find((i) => i.uid === 's1')).toMatchObject({ day: '2026-10-08', reps: 55 });
  });

  it('redeems an invite exactly once, even when raced', async () => {
    const code = 'real-invite-code-0123456789';
    await db.putInvite(hashToken(code), { kind: 'friend', by: 'admin', expiresAt: Date.now() + 60_000 });
    const raced = await Promise.all([1, 2, 3].map((i) => redeemInvite(db, code, `Racer ${i}`, { now: Date.now })));
    const winners = raced.flatMap((r) => (r.ok ? [r] : []));
    expect(winners).toHaveLength(1);
    const w = winners[0]!;
    expect(await db.userIdForToken(hashToken(w.token))).toBe(w.me.id);
    expect(await db.getUser(w.me.id)).toMatchObject({ name: w.me.name });
    expect(await db.getInvite(hashToken(code))).toBeNull();
  });
});
