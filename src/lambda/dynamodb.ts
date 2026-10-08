import { ConditionalCheckFailedException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { BatchGetCommand, type BatchGetCommandOutput, type DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, type QueryCommandInput, type QueryCommandOutput, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { type Db, type StoredDayTotal, type Invite, type StoredEntry, type User, PreconditionFailed } from './db';

// Single-table layout (pk, sk):
//   U#<userId>  P           profile: id, name, createdAt
//   U#<userId>  E#<id>      entry: Entry fields + serverWrittenAt   (LSIs `by-server-written-at` and `by-done-at` index these)
//   U#<userId>  D#<day>     day total: day, reps, sets, bestSetReps, version, userId; monthPk/monthSk feed GSI `by-month`
//   T#<hash>    T           device token: userId, createdAt
//   I#<hash>    I           invite: kind, userId?, createdBy, expiresAt, ttlEpochSeconds (for DynamoDB TTL)
// Only entries carry `serverWrittenAt` and `doneAt`, and only day totals carry `monthPk`, so every index is sparse.

const userPartitionKey = (userId: string) => `U#${userId}`;
const ENTRY_SK_PREFIX = 'E#';
const DAY_SK_PREFIX = 'D#';
const MAX_BATCH_GET = 100;

function itemToEntry(item: Record<string, unknown>): StoredEntry {
  const entry: StoredEntry = { id: item.id as string, doneAt: item.doneAt as number, reps: item.reps as number, updatedAt: item.updatedAt as number, serverWrittenAt: item.serverWrittenAt as number };
  if (item.addedWeightLbs) entry.addedWeightLbs = item.addedWeightLbs as number;
  if (item.deleted) entry.deleted = true;
  return entry;
}

function itemToDayTotal(item: Record<string, unknown>): StoredDayTotal {
  return { day: item.day as string, reps: item.reps as number, sets: item.sets as number, bestSetReps: item.bestSetReps as number, version: item.version as number };
}

/** Maps a lost condition (single put or transaction) to PreconditionFailed. */
async function mapConditionFailure<T>(write: Promise<T>): Promise<T> {
  try {
    return await write;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) throw new PreconditionFailed();
    if (error instanceof TransactionCanceledException && error.CancellationReasons?.some((reason) => reason.Code === 'ConditionalCheckFailed')) throw new PreconditionFailed();
    throw error;
  }
}

/** `attributeName` must be absent (expectedValue null) or still hold `expectedValue`. */
function versionCondition(attributeName: string, expectedValue: number | null) {
  return expectedValue === null
    ? { ConditionExpression: 'attribute_not_exists(pk)' }
    : { ConditionExpression: '#version = :expected', ExpressionAttributeNames: { '#version': attributeName }, ExpressionAttributeValues: { ':expected': expectedValue } };
}

export class DynamoDb implements Db {
  constructor(
    private documentClient: DynamoDBDocumentClient,
    private tableName: string,
  ) {}

  async getEntries(userId: string, ids: string[]) {
    const entriesById = new Map<string, StoredEntry>();
    for (let i = 0; i < ids.length; i += MAX_BATCH_GET) {
      let keys: Record<string, unknown>[] | undefined = ids.slice(i, i + MAX_BATCH_GET).map((id) => ({ pk: userPartitionKey(userId), sk: ENTRY_SK_PREFIX + id }));
      for (let attempt = 0; keys?.length; attempt++) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(1000, 25 * 2 ** attempt)));
        const response: BatchGetCommandOutput = await this.documentClient.send(new BatchGetCommand({ RequestItems: { [this.tableName]: { Keys: keys, ConsistentRead: true } } }));
        for (const item of response.Responses?.[this.tableName] ?? []) entriesById.set(item.id as string, itemToEntry(item));
        keys = response.UnprocessedKeys?.[this.tableName]?.Keys;
      }
    }
    return entriesById;
  }

  async putEntry(userId: string, entry: StoredEntry, expectedServerWrittenAt: number | null) {
    await mapConditionFailure(this.documentClient.send(new PutCommand({ TableName: this.tableName, Item: { pk: userPartitionKey(userId), sk: ENTRY_SK_PREFIX + entry.id, ...entry }, ...versionCondition('serverWrittenAt', expectedServerWrittenAt) })));
  }

  async entriesWrittenAfter(userId: string, serverWrittenAt: number) {
    return this.queryEntries({
      IndexName: 'by-server-written-at',
      KeyConditionExpression: 'pk = :pk AND serverWrittenAt > :serverWrittenAt',
      ExpressionAttributeValues: { ':pk': userPartitionKey(userId), ':serverWrittenAt': serverWrittenAt },
    });
  }

  async entriesDoneBetween(userId: string, fromMs: number, toMs: number) {
    return this.queryEntries({
      IndexName: 'by-done-at',
      KeyConditionExpression: 'pk = :pk AND doneAt BETWEEN :fromMs AND :lastMs',
      ExpressionAttributeValues: { ':pk': userPartitionKey(userId), ':fromMs': fromMs, ':lastMs': toMs - 1 },
    });
  }

  private async queryEntries(input: Omit<QueryCommandInput, 'TableName'>): Promise<StoredEntry[]> {
    const entries: StoredEntry[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const response: QueryCommandOutput = await this.documentClient.send(new QueryCommand({ TableName: this.tableName, ConsistentRead: true, ExclusiveStartKey: exclusiveStartKey, ...input }));
      for (const item of response.Items ?? []) entries.push(itemToEntry(item));
      exclusiveStartKey = response.LastEvaluatedKey;
    } while (exclusiveStartKey);
    return entries;
  }

  async getDayTotal(userId: string, day: string) {
    const response = await this.documentClient.send(new GetCommand({ TableName: this.tableName, Key: { pk: userPartitionKey(userId), sk: DAY_SK_PREFIX + day }, ConsistentRead: true }));
    return response.Item ? itemToDayTotal(response.Item) : null;
  }

  async putDayTotal(userId: string, dayTotal: StoredDayTotal, expectedVersion: number | null) {
    const Item = { pk: userPartitionKey(userId), sk: DAY_SK_PREFIX + dayTotal.day, userId, ...dayTotal, monthPk: `M#${dayTotal.day.slice(0, 7)}`, monthSk: `${dayTotal.day}#${userId}` };
    await mapConditionFailure(this.documentClient.send(new PutCommand({ TableName: this.tableName, Item, ...versionCondition('version', expectedVersion) })));
  }

  async getUser(userId: string) {
    const response = await this.documentClient.send(new GetCommand({ TableName: this.tableName, Key: { pk: userPartitionKey(userId), sk: 'P' }, ConsistentRead: true }));
    return response.Item ? { id: response.Item.id as string, name: response.Item.name as string, createdAt: response.Item.createdAt as number } : null;
  }

  async userIdForToken(tokenHash: string) {
    const response = await this.documentClient.send(new GetCommand({ TableName: this.tableName, Key: { pk: `T#${tokenHash}`, sk: 'T' }, ConsistentRead: true }));
    return (response.Item?.userId as string | undefined) ?? null;
  }

  async putInvite(codeHash: string, invite: Invite) {
    await this.documentClient.send(new PutCommand({ TableName: this.tableName, Item: { pk: `I#${codeHash}`, sk: 'I', ...invite, ttlEpochSeconds: Math.ceil(invite.expiresAt / 1000) } }));
  }

  async getInvite(codeHash: string) {
    const response = await this.documentClient.send(new GetCommand({ TableName: this.tableName, Key: { pk: `I#${codeHash}`, sk: 'I' }, ConsistentRead: true }));
    if (!response.Item) return null;
    const invite: Invite = { kind: response.Item.kind as Invite['kind'], createdBy: response.Item.createdBy as string, expiresAt: response.Item.expiresAt as number };
    if (response.Item.userId) invite.userId = response.Item.userId as string;
    return invite;
  }

  async redeemInvite(codeHash: string, tokenHash: string, userId: string, newUser: User | null) {
    const transactItems: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']> = [
      { Delete: { TableName: this.tableName, Key: { pk: `I#${codeHash}`, sk: 'I' }, ConditionExpression: 'attribute_exists(pk)' } },
      { Put: { TableName: this.tableName, Item: { pk: `T#${tokenHash}`, sk: 'T', userId, createdAt: Date.now() }, ConditionExpression: 'attribute_not_exists(pk)' } },
    ];
    if (newUser) transactItems.push({ Put: { TableName: this.tableName, Item: { pk: userPartitionKey(newUser.id), sk: 'P', ...newUser }, ConditionExpression: 'attribute_not_exists(pk)' } });
    await mapConditionFailure(this.documentClient.send(new TransactWriteCommand({ TransactItems: transactItems })));
  }
}
