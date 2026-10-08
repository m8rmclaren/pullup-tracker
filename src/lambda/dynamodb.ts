import { ConditionalCheckFailedException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { BatchGetCommand, type BatchGetCommandOutput, type DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, type QueryCommandInput, type QueryCommandOutput, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { type Db, type DayTotal, type Invite, type StoredEntry, type User, PreconditionFailed } from './db';

// Single-table layout (pk, sk):
//   U#<uid>   P           profile: id, name, createdAt
//   U#<uid>   E#<id>      entry: Entry fields + srv           (LSIs `by-srv` and `by-ts` index these)
//   U#<uid>   D#<day>     day total: day, reps, sets, best, ver, uid; mpk/msk feed GSI `by-month`
//   T#<hash>  T           device token: uid, createdAt
//   I#<hash>  I           invite: kind, uid?, by, expiresAt, ttl (epoch s, for DynamoDB TTL)
// Only entries carry `srv` and `ts`, and only day totals carry `mpk`, so every index is sparse.

const userPk = (uid: string) => `U#${uid}`;
const ENTRY = 'E#';
const DAY = 'D#';
const MAX_BATCH_GET = 100;

function toEntry(item: Record<string, unknown>): StoredEntry {
  const e: StoredEntry = { id: item.id as string, ts: item.ts as number, reps: item.reps as number, updatedAt: item.updatedAt as number, srv: item.srv as number };
  if (item.lbs) e.lbs = item.lbs as number;
  if (item.deleted) e.deleted = true;
  return e;
}

function toDay(item: Record<string, unknown>): DayTotal {
  return { day: item.day as string, reps: item.reps as number, sets: item.sets as number, best: item.best as number, ver: item.ver as number };
}

/** Maps a lost condition (single put or transaction) to PreconditionFailed. */
async function conditional<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) throw new PreconditionFailed();
    if (err instanceof TransactionCanceledException && err.CancellationReasons?.some((r) => r.Code === 'ConditionalCheckFailed')) throw new PreconditionFailed();
    throw err;
  }
}

/** `attr` must be absent (prev null) or still hold `prev`. */
function versionCondition(attr: string, prev: number | null) {
  return prev === null
    ? { ConditionExpression: 'attribute_not_exists(pk)' }
    : { ConditionExpression: '#v = :prev', ExpressionAttributeNames: { '#v': attr }, ExpressionAttributeValues: { ':prev': prev } };
}

export class DynamoDb implements Db {
  constructor(
    private doc: DynamoDBDocumentClient,
    private table: string,
  ) {}

  async getEntries(uid: string, ids: string[]) {
    const out = new Map<string, StoredEntry>();
    for (let i = 0; i < ids.length; i += MAX_BATCH_GET) {
      let keys: Record<string, unknown>[] | undefined = ids.slice(i, i + MAX_BATCH_GET).map((id) => ({ pk: userPk(uid), sk: ENTRY + id }));
      for (let attempt = 0; keys?.length; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, Math.min(1000, 25 * 2 ** attempt)));
        const res: BatchGetCommandOutput = await this.doc.send(new BatchGetCommand({ RequestItems: { [this.table]: { Keys: keys, ConsistentRead: true } } }));
        for (const item of res.Responses?.[this.table] ?? []) out.set(item.id as string, toEntry(item));
        keys = res.UnprocessedKeys?.[this.table]?.Keys;
      }
    }
    return out;
  }

  async putEntry(uid: string, e: StoredEntry, prevSrv: number | null) {
    await conditional(this.doc.send(new PutCommand({ TableName: this.table, Item: { pk: userPk(uid), sk: ENTRY + e.id, ...e }, ...versionCondition('srv', prevSrv) })));
  }

  async entriesSince(uid: string, srv: number) {
    return this.queryEntries({ IndexName: 'by-srv', KeyConditionExpression: 'pk = :pk AND srv > :s', ExpressionAttributeValues: { ':pk': userPk(uid), ':s': srv } });
  }

  async entriesBetween(uid: string, from: number, to: number) {
    return this.queryEntries({
      IndexName: 'by-ts',
      KeyConditionExpression: 'pk = :pk AND ts BETWEEN :a AND :b',
      ExpressionAttributeValues: { ':pk': userPk(uid), ':a': from, ':b': to - 1 },
    });
  }

  private async queryEntries(input: Omit<QueryCommandInput, 'TableName'>): Promise<StoredEntry[]> {
    const out: StoredEntry[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const res: QueryCommandOutput = await this.doc.send(new QueryCommand({ TableName: this.table, ConsistentRead: true, ExclusiveStartKey: start, ...input }));
      for (const item of res.Items ?? []) out.push(toEntry(item));
      start = res.LastEvaluatedKey;
    } while (start);
    return out;
  }

  async getDay(uid: string, day: string) {
    const res = await this.doc.send(new GetCommand({ TableName: this.table, Key: { pk: userPk(uid), sk: DAY + day }, ConsistentRead: true }));
    return res.Item ? toDay(res.Item) : null;
  }

  async putDay(uid: string, d: DayTotal, prevVer: number | null) {
    const Item = { pk: userPk(uid), sk: DAY + d.day, uid, ...d, mpk: `M#${d.day.slice(0, 7)}`, msk: `${d.day}#${uid}` };
    await conditional(this.doc.send(new PutCommand({ TableName: this.table, Item, ...versionCondition('ver', prevVer) })));
  }

  async getUser(uid: string) {
    const res = await this.doc.send(new GetCommand({ TableName: this.table, Key: { pk: userPk(uid), sk: 'P' }, ConsistentRead: true }));
    return res.Item ? { id: res.Item.id as string, name: res.Item.name as string, createdAt: res.Item.createdAt as number } : null;
  }

  async userIdForToken(tokenHash: string) {
    const res = await this.doc.send(new GetCommand({ TableName: this.table, Key: { pk: `T#${tokenHash}`, sk: 'T' }, ConsistentRead: true }));
    return (res.Item?.uid as string | undefined) ?? null;
  }

  async putInvite(codeHash: string, inv: Invite) {
    await this.doc.send(new PutCommand({ TableName: this.table, Item: { pk: `I#${codeHash}`, sk: 'I', ...inv, ttl: Math.ceil(inv.expiresAt / 1000) } }));
  }

  async getInvite(codeHash: string) {
    const res = await this.doc.send(new GetCommand({ TableName: this.table, Key: { pk: `I#${codeHash}`, sk: 'I' }, ConsistentRead: true }));
    if (!res.Item) return null;
    const inv: Invite = { kind: res.Item.kind as Invite['kind'], by: res.Item.by as string, expiresAt: res.Item.expiresAt as number };
    if (res.Item.uid) inv.uid = res.Item.uid as string;
    return inv;
  }

  async redeemInvite(codeHash: string, tokenHash: string, uid: string, newUser: User | null) {
    const items: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']> = [
      { Delete: { TableName: this.table, Key: { pk: `I#${codeHash}`, sk: 'I' }, ConditionExpression: 'attribute_exists(pk)' } },
      { Put: { TableName: this.table, Item: { pk: `T#${tokenHash}`, sk: 'T', uid, createdAt: Date.now() }, ConditionExpression: 'attribute_not_exists(pk)' } },
    ];
    if (newUser) items.push({ Put: { TableName: this.table, Item: { pk: userPk(newUser.id), sk: 'P', ...newUser }, ConditionExpression: 'attribute_not_exists(pk)' } });
    await conditional(this.doc.send(new TransactWriteCommand({ TransactItems: items })));
  }
}
