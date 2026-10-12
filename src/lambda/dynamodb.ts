import { ConditionalCheckFailedException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { BatchGetCommand, type BatchGetCommandOutput, type DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, type QueryCommandInput, type QueryCommandOutput, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { type Definition, type DefinitionKey, definitionKeyOf, definitionKeyString, normalizeDefinition, parseDefinitionKeyString } from '../shared/definitions';
import { type Db, type StoredDayTotal, type Invite, type StoredDefinition, type StoredEntry, type User, PreconditionFailed } from './db';

// Single-table layout (pk, sk):
//   U#<userId>  P           profile: id, name, createdAt, timeZone? (absent means America/Denver)
//   U#<userId>  E#<id>      entry: Entry fields (exerciseId?, variationIds? as a list, reps or holdSeconds, …) + serverWrittenAt
//                           (LSIs `by-server-written-at` and `by-done-at` index these)
//   U#<userId>  D#<day>     day total: day, reps, sets, bestSetReps, holdSeconds, byExercise (map), version, userId;
//                           monthPk/monthSk feed GSI `by-month`. Totals written before v2 lack holdSeconds and byExercise.
//   T#<hash>    T           device token: userId, createdAt
//   U#<userId>  A#<key>     adopted definition (key is definitionKeyString: `x-…` or `<exerciseId>/v-…`): adoptedAt
//   I#<hash>    I           invite: kind, userId?, createdBy, expiresAt, ttlEpochSeconds (for DynamoDB TTL)
//   X#<exId>    X           created exercise: id, name, measure, unit?, description?, createdBy?, createdAt, updatedAt, version
//   X#<exId>    V#<varId>   created variation on that exercise, built-in or created: id, exerciseId, name, createdBy?, createdAt, updatedAt, version
// Only entries carry `serverWrittenAt` and `doneAt`, and only day totals carry `monthPk`, so every index is sparse.

const userPartitionKey = (userId: string) => `U#${userId}`;
const ENTRY_SK_PREFIX = 'E#';
const DAY_SK_PREFIX = 'D#';
const ADOPTED_SK_PREFIX = 'A#';

function definitionItemKey(key: DefinitionKey) {
  return { pk: `X#${key.exerciseId}`, sk: key.variationId ? `V#${key.variationId}` : 'X' };
}

function itemToDefinition(item: Record<string, unknown>): StoredDefinition {
  return { ...normalizeDefinition(item as unknown as Definition), version: item.version as number };
}
const MAX_BATCH_GET = 100;

function itemToEntry(item: Record<string, unknown>): StoredEntry {
  const entry: StoredEntry = { id: item.id as string, doneAt: item.doneAt as number, updatedAt: item.updatedAt as number, serverWrittenAt: item.serverWrittenAt as number };
  if (item.exerciseId) entry.exerciseId = item.exerciseId as string;
  if ((item.variationIds as string[] | undefined)?.length) entry.variationIds = item.variationIds as string[];
  if (item.reps !== undefined) entry.reps = item.reps as number;
  if (item.holdSeconds !== undefined) entry.holdSeconds = item.holdSeconds as number;
  if (item.addedWeightLbs) entry.addedWeightLbs = item.addedWeightLbs as number;
  if (item.deleted) entry.deleted = true;
  return entry;
}

function itemToDayTotal(item: Record<string, unknown>): StoredDayTotal {
  const dayTotal: StoredDayTotal = { day: item.day as string, reps: item.reps as number, sets: item.sets as number, bestSetReps: item.bestSetReps as number, version: item.version as number };
  if (item.holdSeconds !== undefined) dayTotal.holdSeconds = item.holdSeconds as number;
  if (item.byExercise !== undefined) dayTotal.byExercise = item.byExercise as StoredDayTotal['byExercise'];
  return dayTotal;
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

  /** Strongly consistent, in chunks, retrying whatever DynamoDB leaves unprocessed. */
  private async batchGetItems(itemKeys: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    for (let i = 0; i < itemKeys.length; i += MAX_BATCH_GET) {
      let keys: Record<string, unknown>[] | undefined = itemKeys.slice(i, i + MAX_BATCH_GET);
      for (let attempt = 0; keys?.length; attempt++) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(1000, 25 * 2 ** attempt)));
        const response: BatchGetCommandOutput = await this.documentClient.send(new BatchGetCommand({ RequestItems: { [this.tableName]: { Keys: keys, ConsistentRead: true } } }));
        items.push(...(response.Responses?.[this.tableName] ?? []));
        keys = response.UnprocessedKeys?.[this.tableName]?.Keys;
      }
    }
    return items;
  }

  async getEntries(userId: string, ids: string[]) {
    const items = await this.batchGetItems(ids.map((id) => ({ pk: userPartitionKey(userId), sk: ENTRY_SK_PREFIX + id })));
    return new Map(items.map((item) => [item.id as string, itemToEntry(item)]));
  }

  async getDefinitions(keys: DefinitionKey[]) {
    const uniqueKeys = [...new Map(keys.map((key) => [definitionKeyString(key), key])).values()];
    const items = await this.batchGetItems(uniqueKeys.map(definitionItemKey));
    const definitionsByKey = new Map<string, StoredDefinition>();
    for (const item of items) {
      const definition = itemToDefinition(item);
      definitionsByKey.set(definitionKeyString(definitionKeyOf(definition)), definition);
    }
    return definitionsByKey;
  }

  async createDefinition(definition: StoredDefinition, userId: string, adoptedAt: number) {
    const key = definitionKeyOf(definition);
    await mapConditionFailure(
      this.documentClient.send(
        new TransactWriteCommand({
          TransactItems: [
            { Put: { TableName: this.tableName, Item: { ...definitionItemKey(key), ...definition }, ConditionExpression: 'attribute_not_exists(pk)' } },
            { Put: { TableName: this.tableName, Item: { pk: userPartitionKey(userId), sk: ADOPTED_SK_PREFIX + definitionKeyString(key), adoptedAt } } },
          ],
        }),
      ),
    );
  }

  async putDefinition(definition: StoredDefinition, expectedVersion: number) {
    const Item = { ...definitionItemKey(definitionKeyOf(definition)), ...definition };
    await mapConditionFailure(this.documentClient.send(new PutCommand({ TableName: this.tableName, Item, ...versionCondition('version', expectedVersion) })));
  }

  async adoptedDefinitionKeys(userId: string) {
    const keys: DefinitionKey[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const response: QueryCommandOutput = await this.documentClient.send(
        new QueryCommand({
          TableName: this.tableName,
          ConsistentRead: true,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
          ExpressionAttributeValues: { ':pk': userPartitionKey(userId), ':prefix': ADOPTED_SK_PREFIX },
          ProjectionExpression: 'sk',
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      for (const item of response.Items ?? []) keys.push(parseDefinitionKeyString((item.sk as string).slice(ADOPTED_SK_PREFIX.length)));
      exclusiveStartKey = response.LastEvaluatedKey;
    } while (exclusiveStartKey);
    return keys;
  }

  async adoptDefinition(userId: string, key: DefinitionKey, adoptedAt: number) {
    await this.documentClient.send(new PutCommand({ TableName: this.tableName, Item: { pk: userPartitionKey(userId), sk: ADOPTED_SK_PREFIX + definitionKeyString(key), adoptedAt } }));
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
    if (!response.Item) return null;
    const user: User = { id: response.Item.id as string, name: response.Item.name as string, createdAt: response.Item.createdAt as number };
    if (response.Item.timeZone) user.timeZone = response.Item.timeZone as string;
    return user;
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
