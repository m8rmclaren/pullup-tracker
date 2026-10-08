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
import { syncEntries } from '../src/lambda/sync';
import type { Entry } from '../src/shared/model';

const endpoint = process.env.DYNAMODB_ENDPOINT;
const tableName = `pullups-test-${Date.now()}`;
const client = new DynamoDBClient({ endpoint, region: 'us-west-2', credentials: { accessKeyId: 'x', secretAccessKey: 'x' } });
const documentClient = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
const db = new DynamoDb(documentClient, tableName);

const OCT8 = Date.parse('2026-10-08T18:00:00Z');
let entryCount = 0;
const makeEntry = (doneAt: number, reps = 5, extra: Partial<Entry> = {}): Entry => ({ id: `d${++entryCount}`, doneAt, reps, updatedAt: 1, ...extra });

describe.skipIf(!endpoint)('DynamoDb', () => {
  beforeAll(async () => {
    // Mirrors aws_dynamodb_table.data in infra/main.tf.
    await client.send(
      new CreateTableCommand({
        TableName: tableName,
        BillingMode: 'PAY_PER_REQUEST',
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'sk', AttributeType: 'S' },
          { AttributeName: 'serverWrittenAt', AttributeType: 'N' },
          { AttributeName: 'doneAt', AttributeType: 'N' },
          { AttributeName: 'monthPk', AttributeType: 'S' },
          { AttributeName: 'monthSk', AttributeType: 'S' },
        ],
        LocalSecondaryIndexes: [
          { IndexName: 'by-server-written-at', KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'serverWrittenAt', KeyType: 'RANGE' }], Projection: { ProjectionType: 'ALL' } },
          { IndexName: 'by-done-at', KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'doneAt', KeyType: 'RANGE' }], Projection: { ProjectionType: 'ALL' } },
        ],
        GlobalSecondaryIndexes: [
          { IndexName: 'by-month', KeySchema: [{ AttributeName: 'monthPk', KeyType: 'HASH' }, { AttributeName: 'monthSk', KeyType: 'RANGE' }], Projection: { ProjectionType: 'ALL' } },
        ],
      }),
    );
  });
  afterAll(async () => {
    await client.send(new DeleteTableCommand({ TableName: tableName }));
  });

  it('enforces the entry and day preconditions', async () => {
    const entry = { ...makeEntry(OCT8), serverWrittenAt: 10 };
    await db.putEntry('c1', entry, null);
    await expect(db.putEntry('c1', { ...entry, serverWrittenAt: 11 }, null)).rejects.toBeInstanceOf(PreconditionFailed);
    await expect(db.putEntry('c1', { ...entry, serverWrittenAt: 11 }, 9)).rejects.toBeInstanceOf(PreconditionFailed);
    await db.putEntry('c1', { ...entry, reps: 6, serverWrittenAt: 11 }, 10);
    expect((await db.getEntries('c1', [entry.id, 'missing'])).get(entry.id)).toEqual({ ...entry, reps: 6, serverWrittenAt: 11 });

    await db.putDayTotal('c1', { day: '2026-10-08', reps: 6, sets: 1, bestSetReps: 6, version: 1 }, null);
    await expect(db.putDayTotal('c1', { day: '2026-10-08', reps: 0, sets: 0, bestSetReps: 0, version: 2 }, null)).rejects.toBeInstanceOf(PreconditionFailed);
    await db.putDayTotal('c1', { day: '2026-10-08', reps: 9, sets: 2, bestSetReps: 6, version: 2 }, 1);
    expect(await db.getDayTotal('c1', '2026-10-08')).toEqual({ day: '2026-10-08', reps: 9, sets: 2, bestSetReps: 6, version: 2 });
  });

  it('queries by write time and by set time, per user, across pages', async () => {
    const entries = Array.from({ length: 150 }, (_, i) => ({ ...makeEntry(OCT8 + i, 5, { addedWeightLbs: 2.5 }), serverWrittenAt: 1000 + i }));
    await Promise.all(entries.map((entry) => db.putEntry('q1', entry, null)));
    await db.putEntry('q2', { ...makeEntry(OCT8), serverWrittenAt: 5000 }, null);
    expect(await db.entriesWrittenAfter('q1', 1100)).toHaveLength(49);
    expect(await db.entriesDoneBetween('q1', OCT8 + 10, OCT8 + 20)).toHaveLength(10);
    expect((await db.getEntries('q1', entries.map((entry) => entry.id))).size).toBe(150);
    expect((await db.entriesWrittenAfter('q1', 0))[0]!.addedWeightLbs).toBe(2.5);
  });

  it('syncs concurrently without losing sets, and day totals land in the month index', async () => {
    const pushes = Array.from({ length: 10 }, (_, i) => [makeEntry(OCT8 + i * 1000, i + 1)]);
    await Promise.all(pushes.map((pushedEntries) => syncEntries(db, 's1', pushedEntries, 0)));
    expect((await syncEntries(db, 's1', [], 0)).entries).toHaveLength(10);
    expect(await db.getDayTotal('s1', '2026-10-08')).toMatchObject({ reps: 55, sets: 10, bestSetReps: 10 });

    const board = await documentClient.send(new QueryCommand({ TableName: tableName, IndexName: 'by-month', KeyConditionExpression: 'monthPk = :monthPk', ExpressionAttributeValues: { ':monthPk': 'M#2026-10' } }));
    expect(board.Items?.find((item) => item.userId === 's1')).toMatchObject({ day: '2026-10-08', reps: 55 });
  });

  it('redeems an invite exactly once, even when raced', async () => {
    const code = 'real-invite-code-0123456789';
    await db.putInvite(hashToken(code), { kind: 'friend', createdBy: 'admin', expiresAt: Date.now() + 60_000 });
    const raced = await Promise.all([1, 2, 3].map((i) => redeemInvite(db, code, `Racer ${i}`, { now: Date.now })));
    const winners = raced.flatMap((result) => (result.ok ? [result] : []));
    expect(winners).toHaveLength(1);
    const winner = winners[0]!;
    expect(await db.userIdForToken(hashToken(winner.token))).toBe(winner.account.id);
    expect(await db.getUser(winner.account.id)).toMatchObject({ name: winner.account.name });
    expect(await db.getInvite(hashToken(code))).toBeNull();
  });
});
