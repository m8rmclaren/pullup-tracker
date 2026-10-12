// Runs the DynamoDB adapter against a real DynamoDB (Local), since conditions, indexes and
// transactions are where a fake would agree with itself and be wrong:
//   docker run --rm -p 8000:8000 amazon/dynamodb-local
//   DYNAMODB_ENDPOINT=http://localhost:8000 npm test
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { redeemDeviceLink } from '../src/lambda/accounts';
import { hashToken } from '../src/lambda/auth';
import { PreconditionFailed } from '../src/lambda/db';
import { DynamoDb } from '../src/lambda/dynamodb';
import { route } from '../src/lambda/http';
import { updateProfile } from '../src/lambda/profile';
import { syncEntries } from '../src/lambda/sync';
import type { Entry } from '../src/shared/model';
import { exerciseDayTotals } from '../src/shared/stats';
import { type StatsFixtureCase, loadFixture, toEntries } from './fixtures';
import { SoftAuthenticator } from './softAuthenticator';

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

  it('round-trips every v2 entry field, and leaves a v1 entry without them', async () => {
    const chinUp = { ...makeEntry(OCT8, 5, { exerciseId: 'chin-up', variationIds: ['band', 'negative'], addedWeightLbs: 10 }), serverWrittenAt: 20 };
    const lever = { id: 'lever-d', doneAt: OCT8, updatedAt: 1, exerciseId: 'x-k3p7abcdefgh2345', variationIds: ['v-6qzrabcdefgh2345'], holdSeconds: 95, serverWrittenAt: 21 };
    const v1 = { ...makeEntry(OCT8, 7), serverWrittenAt: 22 };
    await Promise.all([chinUp, lever, v1].map((entry) => db.putEntry('v2', entry, null)));
    const stored = await db.getEntries('v2', [chinUp.id, lever.id, v1.id]);
    expect(stored.get(chinUp.id)).toEqual(chinUp);
    expect(stored.get(lever.id)).toEqual(lever);
    expect(stored.get(v1.id)).toEqual(v1);
    expect(await db.entriesWrittenAfter('v2', 0)).toEqual([chinUp, lever, v1]);
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
    await Promise.all(pushes.map((pushedEntries) => syncEntries(db, 's1', 'America/Denver', pushedEntries, 0)));
    expect((await syncEntries(db, 's1', 'America/Denver', [], 0)).entries).toHaveLength(10);
    expect(await db.getDayTotal('s1', '2026-10-08')).toMatchObject({ reps: 55, sets: 10, bestSetReps: 10 });

    const board = await documentClient.send(new QueryCommand({ TableName: tableName, IndexName: 'by-month', KeyConditionExpression: 'monthPk = :monthPk', ExpressionAttributeValues: { ':monthPk': 'M#2026-10' } }));
    expect(board.Items?.find((item) => item.userId === 's1')).toMatchObject({ day: '2026-10-08', reps: 55 });
  });

  it('stores the v1 golden history with the same day totals it did in v1', async () => {
    const golden = loadFixture<{ cases: StatsFixtureCase[] }>('stats.json').cases.find((fixtureCase) => fixtureCase.dayTotals)!;
    await syncEntries(db, 'golden', 'America/Denver', toEntries(golden.entries), 0);
    for (const [day, expected] of Object.entries(golden.dayTotals!)) expect(await db.getDayTotal('golden', day)).toMatchObject({ day, ...expected });
  });

  it('creates a definition once, adopting it in the same write, and updates it only from the version read', async () => {
    const stairs = { id: 'x-dddddddddddddddd', name: 'Stairs', measure: 'count' as const, unit: 'lap', createdBy: 'dx', createdAt: 1, updatedAt: 1, version: 1 };
    const intoTuck = { id: 'v-dddddddddddddddd', exerciseId: 'pull-up', name: 'Into tuck', createdBy: 'dx', createdAt: 1, updatedAt: 1, version: 1 };
    await db.createDefinition(stairs, 'dx', 5);
    await db.createDefinition(intoTuck, 'dx', 5);
    await expect(db.createDefinition({ ...stairs, name: 'Again' }, 'dy', 6)).rejects.toBeInstanceOf(PreconditionFailed);
    expect(await db.adoptedDefinitionKeys('dy')).toEqual([]);
    expect(await db.adoptedDefinitionKeys('dx')).toEqual([{ exerciseId: 'pull-up', variationId: 'v-dddddddddddddddd' }, { exerciseId: 'x-dddddddddddddddd' }]);

    await expect(db.putDefinition({ ...stairs, name: 'Lost', version: 2 }, 7)).rejects.toBeInstanceOf(PreconditionFailed);
    await db.putDefinition({ ...stairs, name: 'Red Rocks stairs', updatedAt: 2, version: 2 }, 1);
    await db.adoptDefinition('dy', { exerciseId: 'pull-up', variationId: 'v-dddddddddddddddd' }, 8);
    const definitions = await db.getDefinitions([{ exerciseId: 'x-dddddddddddddddd' }, { exerciseId: 'pull-up', variationId: 'v-dddddddddddddddd' }, { exerciseId: 'x-dddddddddddddddd' }, { exerciseId: 'x-zzzzzzzzzzzzzzzz' }]);
    expect(definitions.get('x-dddddddddddddddd')).toEqual({ ...stairs, name: 'Red Rocks stairs', updatedAt: 2, version: 2 });
    expect(definitions.get('pull-up/v-dddddddddddddddd')).toEqual(intoTuck);
    expect(definitions.size).toBe(2);
    expect(await db.adoptedDefinitionKeys('dy')).toEqual([{ exerciseId: 'pull-up', variationId: 'v-dddddddddddddddd' }]);
  });

  it('batch-gets more definitions than one request holds', async () => {
    const ids = Array.from({ length: 130 }, (_, i) => `x-qq${'abcdefghijklmnopqrstuvwxyz234567'[i % 32]!.repeat(7)}${'abcdefghijklmnopqrstuvwxyz234567'[Math.floor(i / 32)]!.repeat(7)}`);
    await Promise.all(ids.map((id) => db.createDefinition({ id, name: id, measure: 'time', createdBy: 'bx', createdAt: 1, updatedAt: 1, version: 1 }, 'bx', 1)));
    expect((await db.getDefinitions(ids.map((exerciseId) => ({ exerciseId })))).size).toBe(130);
    expect(await db.adoptedDefinitionKeys('bx')).toHaveLength(130);
  });

  it('round-trips a v2 day total, and reads a pre-v2 one without the fields it never had', async () => {
    const byExercise = { 'pull-up': { sets: 2, reps: 13, bestSetReps: 7, bestAddedWeightLbs: 25 }, plank: { sets: 1, holdSeconds: 60, bestHoldSeconds: 60 } };
    await db.putDayTotal('t5', { day: '2026-10-08', reps: 13, sets: 3, bestSetReps: 7, holdSeconds: 60, byExercise, version: 1 }, null);
    expect(await db.getDayTotal('t5', '2026-10-08')).toEqual({ day: '2026-10-08', reps: 13, sets: 3, bestSetReps: 7, holdSeconds: 60, byExercise, version: 1 });

    // As v1 wrote it: no holdSeconds, no byExercise.
    await documentClient.send(new PutCommand({ TableName: tableName, Item: { pk: 'U#t5', sk: 'D#2026-10-07', userId: 't5', day: '2026-10-07', reps: 41, sets: 7, bestSetReps: 8, version: 9, monthPk: 'M#2026-10', monthSk: '2026-10-07#t5' } }));
    const legacy = await db.getDayTotal('t5', '2026-10-07');
    expect(legacy).toEqual({ day: '2026-10-07', reps: 41, sets: 7, bestSetReps: 8, version: 9 });
    expect(exerciseDayTotals(legacy!)).toEqual({ 'pull-up': { sets: 7, reps: 41, bestSetReps: 8 } });
  });

  it('edits a profile only from the version read, starting from a pre-v2 profile with none', async () => {
    // As the one production profile is: no version, zone, goal or clocks.
    await documentClient.send(new PutCommand({ TableName: tableName, Item: { pk: 'U#p1', sk: 'P', id: 'p1', name: 'Hayden', createdAt: 1 } }));
    expect(await db.getUser('p1')).toEqual({ id: 'p1', name: 'Hayden', createdAt: 1 });
    await expect(db.putProfile({ id: 'p1', name: 'Hay', createdAt: 1, version: 1 }, 1)).rejects.toBeInstanceOf(PreconditionFailed);
    await expect(db.putProfile({ id: 'nobody', name: 'X', createdAt: 1, version: 1 }, null)).rejects.toBeInstanceOf(PreconditionFailed);
    const edited = { id: 'p1', name: 'Hay', nameUpdatedAt: 5, createdAt: 1, timeZone: 'Europe/London', zoneUpdatedAt: 6, dailyGoalReps: 40, goalUpdatedAt: 7, version: 1 };
    await db.putProfile(edited, null);
    await expect(db.putProfile({ ...edited, version: 2 }, null)).rejects.toBeInstanceOf(PreconditionFailed);
    expect(await db.getUser('p1')).toEqual(edited);
  });

  it('re-keys recent day totals on a zone change, through the real indexes', async () => {
    await documentClient.send(new PutCommand({ TableName: tableName, Item: { pk: 'U#z1', sk: 'P', id: 'z1', name: 'Zed', createdAt: 1 } }));
    const now = { now: () => Date.parse('2026-10-08T18:00:00Z') };
    await syncEntries(db, 'z1', 'America/Denver', [makeEntry(Date.parse('2026-10-08T03:00:00Z'), 5), makeEntry(Date.parse('2026-10-07T15:00:00Z'), 6)], 0, now);
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    await updateProfile(db, 'z1', { timeZone: 'Europe/London', zoneUpdatedAt: 10 }, now);
    logs.mockRestore();
    expect(await db.getDayTotal('z1', '2026-10-07')).toMatchObject({ reps: 6, sets: 1 });
    expect(await db.getDayTotal('z1', '2026-10-08')).toMatchObject({ reps: 5, sets: 1 });
    expect(await db.getDayTotal('z1', '2026-10-01')).toBeNull();
    expect(await db.getUser('z1')).toMatchObject({ timeZone: 'Europe/London', version: 1 });
  });

  it('redeems a device link exactly once, even when raced', async () => {
    await documentClient.send(new PutCommand({ TableName: tableName, Item: { pk: 'U#r1', sk: 'P', id: 'r1', name: 'Racer', createdAt: 1 } }));
    const code = 'real-device-link-0123456789';
    await db.putInvite(hashToken(code), { kind: 'device', userId: 'r1', createdBy: 'r1', expiresAt: Date.now() + 60_000 });
    const raced = await Promise.allSettled([1, 2, 3].map(() => redeemDeviceLink(db, code, { now: Date.now })));
    const winners = raced.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
    expect(winners).toHaveLength(1);
    expect(await db.userIdForToken(hashToken(winners[0]!.token))).toBe('r1');
    expect(await db.getInvite(hashToken(code))).toBeNull();
    const backReference = await documentClient.send(new QueryCommand({ TableName: tableName, KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)', ExpressionAttributeValues: { ':pk': 'U#r1', ':prefix': 'T#' } }));
    expect(backReference.Items).toEqual([expect.objectContaining({ sk: `T#${hashToken(winners[0]!.token)}` })]);
  });

  it('takes a challenge exactly once, even when raced', async () => {
    await db.putChallenge('c-race', { purpose: 'signup', userId: 'n1', name: 'New', timeZone: 'Europe/London', expiresAt: 5 });
    const taken = await Promise.all([1, 2, 3].map(() => db.takeChallenge('c-race')));
    expect(taken.filter(Boolean)).toEqual([{ purpose: 'signup', userId: 'n1', name: 'New', timeZone: 'Europe/London', expiresAt: 5 }]);
    expect(await db.takeChallenge('never-issued')).toBeNull();
  });

  it('creates an account with its passkey, token and sweep marker in one write, once', async () => {
    const user = { id: 'k1', name: 'Kay', createdAt: 7, timeZone: 'Europe/London' };
    const passkey = { credentialId: 'cred-k1', publicKey: 'pk', counter: 0, transports: ['internal'], createdAt: 7, label: 'Pixel' };
    await db.createAccount({ user, passkey, tokenHash: 'tok-k1', sweepDay: '2026-11-07' });
    await expect(db.createAccount({ user: { ...user, name: 'Again' }, passkey: { ...passkey, credentialId: 'cred-k1b' }, tokenHash: 'tok-k1b', sweepDay: '2026-11-07' })).rejects.toBeInstanceOf(PreconditionFailed);
    expect(await db.getUser('k1')).toEqual(user);
    expect(await db.userIdForToken('tok-k1')).toBe('k1');
    expect(await db.userIdForToken('tok-k1b')).toBeNull();
    expect(await db.passkeysOf('k1')).toEqual([passkey]);
    const marker = await documentClient.send(new QueryCommand({ TableName: tableName, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': 'W#2026-11-07' } }));
    expect(marker.Items).toEqual([{ pk: 'W#2026-11-07', sk: 'U#k1' }]);

    await expect(db.addPasskey('k1', passkey)).rejects.toBeInstanceOf(PreconditionFailed);
    await db.addPasskey('k1', { credentialId: 'cred-k1c', publicKey: 'pk2', counter: 0, createdAt: 8 });
    await db.putPasskey('k1', { ...passkey, counter: 4 });
    expect(await db.getPasskey('k1', 'cred-k1')).toEqual({ ...passkey, counter: 4 });
    expect(await db.getPasskey('k1', 'missing')).toBeNull();
    expect(await db.passkeysOf('k1')).toHaveLength(2);

    await db.putToken('tok-k1d', 'k1', 9);
    await expect(db.putToken('tok-k1d', 'k1', 9)).rejects.toBeInstanceOf(PreconditionFailed);
    expect(await db.userIdForToken('tok-k1d')).toBe('k1');
  });

  it('signs up, signs in and adds a passkey through the router', async () => {
    const origin = 'https://pullups.example.com';
    const deps = { db, webAuthn: { rpId: 'pullups.example.com', rpName: 'Pull-ups', origins: [origin] }, isSignupOpen: true };
    const post = async (path: string, body: unknown = {}, token?: string) => route({ method: 'POST', path, headers: token ? { 'x-pullup-token': token } : {}, body: JSON.stringify(body) }, deps);
    const phone = new SoftAuthenticator();
    const signupOptions = await post('/api/signup/options', { name: 'Dee', timeZone: 'Europe/London' });
    const signedUp = await post('/api/signup', { credential: phone.create(signupOptions.body as never, origin), label: 'Pixel' });
    expect(signedUp).toMatchObject({ status: 200, body: { account: { name: 'Dee', timeZone: 'Europe/London' } } });
    const { token, account } = signedUp.body as { token: string; account: { id: string } };

    const loginOptions = await post('/api/passkey/login/options');
    const credential = phone.get(loginOptions.body as never, origin);
    expect(await post('/api/passkey/login', { credential })).toMatchObject({ status: 200, body: { account: { id: account.id } } });
    expect((await post('/api/passkey/login', { credential })).status).toBe(400);

    const laptop = new SoftAuthenticator();
    const registerOptions = await post('/api/passkey/register/options', {}, token);
    expect(await post('/api/passkey/register', { credential: laptop.create(registerOptions.body as never, origin) }, token)).toMatchObject({ status: 200, body: { passkeys: [{ label: 'Pixel' }, {}] } });
    const laptopOptions = await post('/api/passkey/login/options');
    expect(await post('/api/passkey/login', { credential: laptop.get(laptopOptions.body as never, origin) })).toMatchObject({ status: 200, body: { account: { id: account.id } } });
  });
});
