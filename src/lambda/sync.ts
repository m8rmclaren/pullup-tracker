import { type Entry, type MonthDoc, type SyncRequest, type SyncResponse, mergeLists } from '../shared/model';
import { monthKey } from '../shared/time';
import { type ObjectStore, PreconditionFailed } from './store';

export const MONTH_PREFIX = 'months/';
const MAX_ATTEMPTS = 8;

const keyFor = (month: string) => `${MONTH_PREFIX}${month}.json`;
const monthOf = (key: string) => key.slice(MONTH_PREFIX.length, -'.json'.length);

function parse(body: string): Entry[] {
  return (JSON.parse(body) as MonthDoc).entries;
}

/** Read-merge-write one month with optimistic concurrency, so concurrent writers never drop each other's sets. */
export async function mergeMonth(store: ObjectStore, month: string, incoming: Entry[]): Promise<{ etag: string; entries: Entry[] }> {
  const key = keyFor(month);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const cur = await store.get(key);
    const { entries, changed } = mergeLists(cur ? parse(cur.body) : [], incoming);
    if (cur && !changed) return { etag: cur.etag, entries };
    const doc: MonthDoc = { v: 1, entries };
    try {
      const etag = await store.put(key, JSON.stringify(doc), cur ? { ifMatch: cur.etag } : { ifNoneMatch: true });
      return { etag, entries };
    } catch (err) {
      if (!(err instanceof PreconditionFailed)) throw err;
      await new Promise((r) => setTimeout(r, Math.random() * 20 * (attempt + 1)));
    }
  }
  throw new Error(`gave up merging ${month} after ${MAX_ATTEMPTS} conflicting writes`);
}

export async function handleSync(store: ObjectStore, req: SyncRequest): Promise<SyncResponse> {
  const byMonth = new Map<string, Entry[]>();
  for (const e of req.push) {
    const m = monthKey(e.ts);
    const list = byMonth.get(m) ?? [];
    list.push(e);
    byMonth.set(m, list);
  }

  const written = new Map<string, { etag: string; entries: Entry[] }>();
  await Promise.all(
    [...byMonth].map(async ([m, es]) => {
      written.set(m, await mergeMonth(store, m, es));
    }),
  );

  const months: SyncResponse['months'] = {};
  const listing = await store.list(MONTH_PREFIX);
  await Promise.all(
    listing.map(async ({ key, etag }) => {
      const m = monthOf(key);
      const mine = written.get(m);
      // The listing can already show a newer write from another device than ours.
      if (mine && mine.etag === etag) {
        if (req.have[m] !== etag) months[m] = mine;
        return;
      }
      if (req.have[m] === etag) return;
      const obj = await store.get(key);
      if (obj) months[m] = { etag: obj.etag, entries: parse(obj.body) };
    }),
  );
  return { months };
}
