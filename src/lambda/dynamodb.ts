import { ConditionalCheckFailedException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { BatchGetCommand, type BatchGetCommandOutput, DeleteCommand, type DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, type QueryCommandInput, type QueryCommandOutput, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { type Definition, type DefinitionKey, definitionKeyOf, definitionKeyString, normalizeDefinition, parseDefinitionKeyString } from '../shared/definitions';
import { type Db, type FriendLink, type Invite, type Link, type NewAccount, type Passkey, type PendingChallenge, type StoredDayTotal, type StoredDefinition, type StoredEntry, type User, PreconditionFailed } from './db';

// Single-table layout (pk, sk):
//   U#<userId>  P           profile: id, name, createdAt, and once edited version, nameUpdatedAt, timeZone/zoneUpdatedAt,
//                           dailyGoalReps/goalUpdatedAt (timeZone absent means America/Denver)
//   U#<userId>  E#<id>      entry: Entry fields (exerciseId?, variationIds? as a list, reps or holdSeconds, …) + serverWrittenAt
//                           (LSIs `by-server-written-at` and `by-done-at` index these)
//   U#<userId>  D#<day>     day total: day, reps, sets, bestSetReps, holdSeconds, byExercise (map), version, userId;
//                           monthPk/monthSk feed GSI `by-month`. Totals written before v2 lack holdSeconds and byExercise.
//   T#<hash>    T           device (session) token: userId, createdAt
//   U#<userId>  T#<hash>    the same token from the user's side, so an account's tokens can be found: createdAt
//                           (tokens issued before passkeys have no such item)
//   U#<userId>  K#<credId>  passkey: credentialId, publicKey (COSE, base64url), counter, transports?, createdAt, label?
//   U#<userId>  A#<key>     adopted definition (key is definitionKeyString: `x-…` or `<exerciseId>/v-…`): adoptedAt
//   U#<userId>  L           the user's friend link: code (readable, so every device can show it), codeHash
//   U#<userId>  F#<friendId> friendship, written on both sides in one transaction: createdAt
//   I#<hash>    I           device link: kind 'device', userId, createdBy, expiresAt, ttlEpochSeconds (for DynamoDB TTL)
//                           or shared link: kind 'friend' | 'challenge', createdBy, createdAt, openCount, joinCount, version,
//                           challengeId?, expiresAt?/ttlEpochSeconds? (challenge links). A friend invite from before passkeys
//                           has kind 'friend' and expiresAt but no openCount, and is neither.
//   C#<hash>    C           pending WebAuthn challenge: purpose, userId?, name?, timeZone?, expiresAt, ttlEpochSeconds
//   W#<day>     U#<userId>  the empty-account sweep looks at this account on <day>
//   X#<exId>    X           created exercise: id, name, measure, unit?, description?, createdBy?, createdAt, updatedAt, version
//   X#<exId>    V#<varId>   created variation on that exercise, built-in or created: id, exerciseId, name, createdBy?, createdAt, updatedAt, version
// Only entries carry `serverWrittenAt` and `doneAt`, and only day totals carry `monthPk`, so every index is sparse.

const userPartitionKey = (userId: string) => `U#${userId}`;
const ENTRY_SK_PREFIX = 'E#';
const DAY_SK_PREFIX = 'D#';
const ADOPTED_SK_PREFIX = 'A#';
const PASSKEY_SK_PREFIX = 'K#';
const TOKEN_SK_PREFIX = 'T#';
const FRIEND_SK_PREFIX = 'F#';
const linkKey = (codeHash: string) => ({ pk: `I#${codeHash}`, sk: 'I' });

type TransactItems = NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']>;

function itemToPasskey(item: Record<string, unknown>): Passkey {
  const passkey: Passkey = { credentialId: item.credentialId as string, publicKey: item.publicKey as string, counter: item.counter as number, createdAt: item.createdAt as number };
  if (item.transports) passkey.transports = item.transports as string[];
  if (item.label) passkey.label = item.label as string;
  return passkey;
}

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

// Every optional attribute of the profile item. putProfile replaces the whole item, so one missing here would be erased by the next edit.
const USER_OPTIONAL_FIELDS = ['nameUpdatedAt', 'timeZone', 'zoneUpdatedAt', 'dailyGoalReps', 'goalUpdatedAt', 'version', 'joinedVia'] as const;

function itemToUser(item: Record<string, unknown>): User {
  const user: User = { id: item.id as string, name: item.name as string, createdAt: item.createdAt as number };
  for (const field of USER_OPTIONAL_FIELDS) if (item[field] !== undefined) (user as unknown as Record<string, unknown>)[field] = item[field];
  return user;
}

function itemToLink(item: Record<string, unknown>): Link | null {
  if ((item.kind !== 'friend' && item.kind !== 'challenge') || item.openCount === undefined) return null;
  const link: Link = { kind: item.kind, createdBy: item.createdBy as string, createdAt: item.createdAt as number, openCount: item.openCount as number, joinCount: item.joinCount as number, version: item.version as number };
  if (item.challengeId) link.challengeId = item.challengeId as string;
  if (item.expiresAt !== undefined) link.expiresAt = item.expiresAt as number;
  return link;
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

  /** Every item a query matches, strongly consistent, across pages. */
  private async queryAll(input: Omit<QueryCommandInput, 'TableName' | 'ConsistentRead' | 'ExclusiveStartKey'>): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const response: QueryCommandOutput = await this.documentClient.send(new QueryCommand({ TableName: this.tableName, ConsistentRead: true, ExclusiveStartKey: exclusiveStartKey, ...input }));
      items.push(...(response.Items ?? []));
      exclusiveStartKey = response.LastEvaluatedKey;
    } while (exclusiveStartKey);
    return items;
  }

  /** A user's items whose sort key starts with `prefix`. */
  private queryUserItems(userId: string, prefix: string, projection?: string) {
    return this.queryAll({
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': userPartitionKey(userId), ':prefix': prefix },
      ...(projection ? { ProjectionExpression: projection } : {}),
    });
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
    return (await this.queryUserItems(userId, ADOPTED_SK_PREFIX, 'sk')).map((item) => parseDefinitionKeyString((item.sk as string).slice(ADOPTED_SK_PREFIX.length)));
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
    return (await this.queryAll(input)).map(itemToEntry);
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
    return response.Item ? itemToUser(response.Item) : null;
  }

  async getUsers(userIds: string[]) {
    const items = await this.batchGetItems([...new Set(userIds)].map((userId) => ({ pk: userPartitionKey(userId), sk: 'P' })));
    return new Map(items.map((item) => [item.id as string, itemToUser(item)]));
  }

  // A put replaces the whole item (the API role may not UpdateItem), so every profile attribute must be a field of User.
  async putProfile(user: User, expectedVersion: number | null) {
    const condition =
      expectedVersion === null
        ? { ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(#version)', ExpressionAttributeNames: { '#version': 'version' } }
        : { ConditionExpression: '#version = :expected', ExpressionAttributeNames: { '#version': 'version' }, ExpressionAttributeValues: { ':expected': expectedVersion } };
    await mapConditionFailure(this.documentClient.send(new PutCommand({ TableName: this.tableName, Item: { pk: userPartitionKey(user.id), sk: 'P', ...user }, ...condition })));
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

  private tokenPuts(tokenHash: string, userId: string, createdAt: number): TransactItems {
    return [
      { Put: { TableName: this.tableName, Item: { pk: `T#${tokenHash}`, sk: 'T', userId, createdAt }, ConditionExpression: 'attribute_not_exists(pk)' } },
      { Put: { TableName: this.tableName, Item: { pk: userPartitionKey(userId), sk: TOKEN_SK_PREFIX + tokenHash, createdAt } } },
    ];
  }

  async putToken(tokenHash: string, userId: string, createdAt: number) {
    await mapConditionFailure(this.documentClient.send(new TransactWriteCommand({ TransactItems: this.tokenPuts(tokenHash, userId, createdAt) })));
  }

  async redeemInvite(codeHash: string, tokenHash: string, userId: string, createdAt: number) {
    const transactItems: TransactItems = [{ Delete: { TableName: this.tableName, Key: { pk: `I#${codeHash}`, sk: 'I' }, ConditionExpression: 'attribute_exists(pk)' } }, ...this.tokenPuts(tokenHash, userId, createdAt)];
    await mapConditionFailure(this.documentClient.send(new TransactWriteCommand({ TransactItems: transactItems })));
  }

  async putChallenge(challengeHash: string, challenge: PendingChallenge) {
    await this.documentClient.send(new PutCommand({ TableName: this.tableName, Item: { pk: `C#${challengeHash}`, sk: 'C', ...challenge, ttlEpochSeconds: Math.ceil(challenge.expiresAt / 1000) } }));
  }

  async takeChallenge(challengeHash: string) {
    try {
      const response = await this.documentClient.send(new DeleteCommand({ TableName: this.tableName, Key: { pk: `C#${challengeHash}`, sk: 'C' }, ConditionExpression: 'attribute_exists(pk)', ReturnValues: 'ALL_OLD' }));
      const item = response.Attributes!;
      const challenge: PendingChallenge = { purpose: item.purpose as PendingChallenge['purpose'], expiresAt: item.expiresAt as number };
      for (const field of ['userId', 'name', 'timeZone', 'linkCodeHash'] as const) if (item[field] !== undefined) challenge[field] = item[field] as string;
      return challenge;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return null;
      throw error;
    }
  }

  async passkeysOf(userId: string) {
    return (await this.queryUserItems(userId, PASSKEY_SK_PREFIX)).map(itemToPasskey);
  }

  async getPasskey(userId: string, credentialId: string) {
    const response = await this.documentClient.send(new GetCommand({ TableName: this.tableName, Key: { pk: userPartitionKey(userId), sk: PASSKEY_SK_PREFIX + credentialId }, ConsistentRead: true }));
    return response.Item ? itemToPasskey(response.Item) : null;
  }

  private passkeyItem(userId: string, passkey: Passkey) {
    return { pk: userPartitionKey(userId), sk: PASSKEY_SK_PREFIX + passkey.credentialId, ...passkey };
  }

  async addPasskey(userId: string, passkey: Passkey) {
    await mapConditionFailure(this.documentClient.send(new PutCommand({ TableName: this.tableName, Item: this.passkeyItem(userId, passkey), ConditionExpression: 'attribute_not_exists(pk)' })));
  }

  async putPasskey(userId: string, passkey: Passkey) {
    await this.documentClient.send(new PutCommand({ TableName: this.tableName, Item: this.passkeyItem(userId, passkey) }));
  }

  async createAccount({ user, passkey, tokenHash, sweepDay, friendId }: NewAccount) {
    const transactItems: TransactItems = [
      ...(friendId ? this.friendshipPuts(user.id, friendId, user.createdAt) : []),
      { Put: { TableName: this.tableName, Item: { pk: userPartitionKey(user.id), sk: 'P', ...user }, ConditionExpression: 'attribute_not_exists(pk)' } },
      { Put: { TableName: this.tableName, Item: this.passkeyItem(user.id, passkey), ConditionExpression: 'attribute_not_exists(pk)' } },
      ...this.tokenPuts(tokenHash, user.id, user.createdAt),
      { Put: { TableName: this.tableName, Item: { pk: `W#${sweepDay}`, sk: userPartitionKey(user.id) } } },
    ];
    await mapConditionFailure(this.documentClient.send(new TransactWriteCommand({ TransactItems: transactItems })));
  }

  async getLink(codeHash: string) {
    const response = await this.documentClient.send(new GetCommand({ TableName: this.tableName, Key: linkKey(codeHash), ConsistentRead: true }));
    return response.Item ? itemToLink(response.Item) : null;
  }

  private linkItem(codeHash: string, link: Link) {
    return { ...linkKey(codeHash), ...link, ...(link.expiresAt ? { ttlEpochSeconds: Math.ceil(link.expiresAt / 1000) } : {}) };
  }

  async putLink(codeHash: string, link: Link, expectedVersion: number) {
    await mapConditionFailure(this.documentClient.send(new PutCommand({ TableName: this.tableName, Item: this.linkItem(codeHash, link), ...versionCondition('version', expectedVersion) })));
  }

  async getFriendLink(userId: string) {
    const response = await this.documentClient.send(new GetCommand({ TableName: this.tableName, Key: { pk: userPartitionKey(userId), sk: 'L' }, ConsistentRead: true }));
    return response.Item ? { code: response.Item.code as string, codeHash: response.Item.codeHash as string } : null;
  }

  async replaceFriendLink(userId: string, next: FriendLink, link: Link, previous: FriendLink | null) {
    const ownerCondition = previous
      ? { ConditionExpression: 'codeHash = :previous', ExpressionAttributeValues: { ':previous': previous.codeHash } }
      : { ConditionExpression: 'attribute_not_exists(pk)' };
    const transactItems: TransactItems = [
      { Put: { TableName: this.tableName, Item: { pk: userPartitionKey(userId), sk: 'L', ...next }, ...ownerCondition } },
      { Put: { TableName: this.tableName, Item: this.linkItem(next.codeHash, link), ConditionExpression: 'attribute_not_exists(pk)' } },
    ];
    if (previous) transactItems.push({ Delete: { TableName: this.tableName, Key: linkKey(previous.codeHash) } });
    await mapConditionFailure(this.documentClient.send(new TransactWriteCommand({ TransactItems: transactItems })));
  }

  async friendIds(userId: string) {
    return (await this.queryUserItems(userId, FRIEND_SK_PREFIX, 'sk')).map((item) => (item.sk as string).slice(FRIEND_SK_PREFIX.length));
  }

  async isFriend(userId: string, otherUserId: string) {
    const response = await this.documentClient.send(new GetCommand({ TableName: this.tableName, Key: { pk: userPartitionKey(userId), sk: FRIEND_SK_PREFIX + otherUserId }, ConsistentRead: true }));
    return !!response.Item;
  }

  private friendshipPuts(userId: string, friendId: string, createdAt: number): TransactItems {
    return [
      { Put: { TableName: this.tableName, Item: { pk: userPartitionKey(userId), sk: FRIEND_SK_PREFIX + friendId, createdAt }, ConditionExpression: 'attribute_not_exists(pk)' } },
      { Put: { TableName: this.tableName, Item: { pk: userPartitionKey(friendId), sk: FRIEND_SK_PREFIX + userId, createdAt } } },
    ];
  }

  async befriend(userId: string, friendId: string, createdAt: number) {
    await mapConditionFailure(this.documentClient.send(new TransactWriteCommand({ TransactItems: this.friendshipPuts(userId, friendId, createdAt) })));
  }

  async unfriend(userId: string, friendId: string) {
    await this.documentClient.send(
      new TransactWriteCommand({
        TransactItems: [
          { Delete: { TableName: this.tableName, Key: { pk: userPartitionKey(userId), sk: FRIEND_SK_PREFIX + friendId } } },
          { Delete: { TableName: this.tableName, Key: { pk: userPartitionKey(friendId), sk: FRIEND_SK_PREFIX + userId } } },
        ],
      }),
    );
  }
}
