import { describe, expect, it } from 'vitest';
import type { Entry } from '../src/shared/model';
import { DEVICE_LINK_TTL_MS, createInvite } from '../src/lambda/accounts';
import { hashToken } from '../src/lambda/auth';
import { type StoredEntry, MemoryDb } from '../src/lambda/db';
import { route } from '../src/lambda/http';
import { CURSOR_LAG_MS, syncEntries, recomputeDayTotal } from '../src/lambda/sync';

const OCT8 = Date.parse('2026-10-08T18:00:00Z');
const OCT9 = Date.parse('2026-10-09T18:00:00Z');
const USER_ID = 'u1';
let entryCount = 0;
const makeEntry = (doneAt: number, reps = 5, extra: Partial<Entry> = {}): Entry => ({ id: `id${++entryCount}`, doneAt, reps, updatedAt: 1, ...extra });
const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

/** Yields around every read and write so concurrent requests interleave the worst way. */
class InterleavingDb extends MemoryDb {
  override async getEntries(userId: string, ids: string[]) {
    await tick();
    const entriesById = await super.getEntries(userId, ids);
    await tick();
    return entriesById;
  }
  override async entriesDoneBetween(userId: string, fromMs: number, toMs: number) {
    const entries = await super.entriesDoneBetween(userId, fromMs, toMs);
    await tick();
    return entries;
  }
  override async getDayTotal(userId: string, day: string) {
    const dayTotal = await super.getDayTotal(userId, day);
    await tick();
    return dayTotal;
  }
}

describe('syncEntries', () => {
  it('returns everything on a first sync, then only what was written since the cursor', async () => {
    const db = new MemoryDb();
    let nowMs = OCT8;
    const clock = { now: () => nowMs };
    const first = makeEntry(OCT8);
    const firstSync = await syncEntries(db, USER_ID, [first], 0, clock);
    expect(firstSync.entries).toEqual([first]);
    expect(firstSync.cursor).toBe(OCT8 - CURSOR_LAG_MS);

    // Each write was younger than the lag when the cursor was cut, so it comes back once more.
    nowMs += 10 * 60_000;
    const second = makeEntry(OCT8 + 1);
    const secondSync = await syncEntries(db, USER_ID, [second], firstSync.cursor, clock);
    expect(secondSync.entries).toEqual([first, second]);

    nowMs += 10 * 60_000;
    const thirdSync = await syncEntries(db, USER_ID, [], secondSync.cursor, clock);
    expect(thirdSync.entries).toEqual([second]);

    nowMs += 10 * 60_000;
    expect((await syncEntries(db, USER_ID, [], thirdSync.cursor, clock)).entries).toEqual([]);
  });

  it('still delivers a write that commits after a later sync has started', async () => {
    let nowMs = OCT8;
    const clock = { now: () => nowMs };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    class SlowDb extends MemoryDb {
      override async putEntry(userId: string, entry: StoredEntry, expectedServerWrittenAt: number | null) {
        await gate;
        return super.putEntry(userId, entry, expectedServerWrittenAt);
      }
    }
    const db = new SlowDb();
    const slow = syncEntries(db, USER_ID, [makeEntry(OCT8)], 0, clock); // stamped at nowMs, not yet committed
    await tick();
    nowMs += 5000;
    const reader = await syncEntries(new MemoryDb(), USER_ID, [], 0, clock); // cursor from another, faster request
    release();
    await slow;
    expect((await syncEntries(db, USER_ID, [], reader.cursor, clock)).entries).toHaveLength(1);
  });

  it('keeps day totals for the leaderboard, through edits, deletes and moves between days', async () => {
    const db = new MemoryDb();
    const first = makeEntry(OCT8, 5);
    const second = makeEntry(OCT8, 8, { addedWeightLbs: 25 });
    await syncEntries(db, USER_ID, [first, second], 0);
    expect(await db.getDayTotal(USER_ID, '2026-10-08')).toMatchObject({ reps: 13, sets: 2, bestSetReps: 8 });

    await syncEntries(db, USER_ID, [{ ...first, deleted: true, updatedAt: 2 }], 0);
    expect(await db.getDayTotal(USER_ID, '2026-10-08')).toMatchObject({ reps: 8, sets: 1, bestSetReps: 8 });

    await syncEntries(db, USER_ID, [{ ...second, doneAt: OCT9, updatedAt: 2 }], 0);
    expect(await db.getDayTotal(USER_ID, '2026-10-08')).toMatchObject({ reps: 0, sets: 0 });
    expect(await db.getDayTotal(USER_ID, '2026-10-09')).toMatchObject({ reps: 8, sets: 1 });
  });

  it('heals a day total when a retried push finds its entry already written', async () => {
    const db = new MemoryDb();
    const entry = makeEntry(OCT8, 7);
    // As if a request wrote the entry and then timed out before totalling the day.
    await db.putEntry(USER_ID, { ...entry, serverWrittenAt: 1 }, null);
    await syncEntries(db, USER_ID, [entry], 0);
    expect(await db.getDayTotal(USER_ID, '2026-10-08')).toMatchObject({ reps: 7 });
  });

  it('loses no sets, and no reps from the total, when many devices push at once', async () => {
    const db = new InterleavingDb();
    const pushes = Array.from({ length: 12 }, (_, i) => [makeEntry(OCT8 + i * 1000, (i % 6) + 3)]);
    await Promise.all(pushes.map((pushedEntries) => syncEntries(db, USER_ID, pushedEntries, 0)));
    const allEntries = (await syncEntries(db, USER_ID, [], 0)).entries;
    expect(allEntries).toHaveLength(12);
    expect((await db.getDayTotal(USER_ID, '2026-10-08'))!.reps).toBe(allEntries.reduce((reps, entry) => reps + entry.reps, 0));
  });

  it('a concurrent edit and delete converge to the newer one', async () => {
    const db = new InterleavingDb();
    const base = makeEntry(OCT8, 5);
    await syncEntries(db, USER_ID, [base], 0);
    await Promise.all([syncEntries(db, USER_ID, [{ ...base, reps: 7, updatedAt: 10 }], 0), syncEntries(db, USER_ID, [{ ...base, deleted: true, updatedAt: 11 }], 0)]);
    expect((await syncEntries(db, USER_ID, [], 0)).entries).toEqual([{ ...base, deleted: true, updatedAt: 11 }]);
    expect(await db.getDayTotal(USER_ID, '2026-10-08')).toMatchObject({ reps: 0, sets: 0 });
  });

  it('ignores a stale version and does not rewrite the entry', async () => {
    const db = new MemoryDb();
    const entry = makeEntry(OCT8, 5, { updatedAt: 10 });
    await syncEntries(db, USER_ID, [entry], 0);
    const serverWrittenAt = db.entries.get(USER_ID)!.get(entry.id)!.serverWrittenAt;
    await syncEntries(db, USER_ID, [{ ...entry, reps: 9, updatedAt: 3 }], 0);
    expect(db.entries.get(USER_ID)!.get(entry.id)).toMatchObject({ reps: 5, serverWrittenAt });
  });

  it('a stale recompute cannot overwrite a newer total', async () => {
    const db = new InterleavingDb();
    await syncEntries(db, USER_ID, [makeEntry(OCT8, 5)], 0);
    await Promise.all([recomputeDayTotal(db, USER_ID, '2026-10-08'), syncEntries(db, USER_ID, [makeEntry(OCT8, 6)], 0), recomputeDayTotal(db, USER_ID, '2026-10-08')]);
    expect((await db.getDayTotal(USER_ID, '2026-10-08'))!.reps).toBe(11);
  });
});

describe('route', () => {
  const USER_ONE_TOKEN = 'device-token-for-user-one-0123456789';
  const USER_TWO_TOKEN = 'device-token-for-user-two-0123456789';
  const setup = () => {
    const db = new MemoryDb();
    db.users.set('u1', { id: 'u1', name: 'One', createdAt: 1 });
    db.users.set('u2', { id: 'u2', name: 'Two', createdAt: 1 });
    db.tokens.set(hashToken(USER_ONE_TOKEN), 'u1');
    db.tokens.set(hashToken(USER_TWO_TOKEN), 'u2');
    return db;
  };
  const post = (db: MemoryDb, path: string, body: unknown, token?: string, now = Date.now) =>
    route({ method: 'POST', path, headers: token ? { 'x-pullup-token': token } : {}, body: JSON.stringify(body) }, { db, clock: { now } });

  it('syncs per account, and one user never sees another user’s sets', async () => {
    const db = setup();
    const mine = makeEntry(OCT8, 9);
    const userOneSync = await post(db, '/api/sync', { pushedEntries: [mine], sinceCursor: 0 }, USER_ONE_TOKEN);
    expect(userOneSync).toMatchObject({ status: 200, body: { entries: [mine], account: { id: 'u1', name: 'One' } } });
    const userTwoSync = await post(db, '/api/sync', { pushedEntries: [], sinceCursor: 0 }, USER_TWO_TOKEN);
    expect(userTwoSync).toMatchObject({ status: 200, body: { entries: [], account: { id: 'u2' } } });
  });

  it('rejects a missing or unknown token before touching storage', async () => {
    const db = setup();
    expect((await post(db, '/api/sync', { pushedEntries: [makeEntry(OCT8)], sinceCursor: 0 })).status).toBe(401);
    expect((await post(db, '/api/sync', { pushedEntries: [makeEntry(OCT8)], sinceCursor: 0 }, USER_ONE_TOKEN + 'x')).status).toBe(401);
    expect((await post(db, '/api/invite', { kind: 'friend' })).status).toBe(401);
    expect(db.entries.size).toBe(0);
  });

  it('rejects invalid bodies and unknown routes', async () => {
    const db = setup();
    expect((await route({ method: 'POST', path: '/api/sync', headers: { 'x-pullup-token': USER_ONE_TOKEN }, body: '{' }, { db })).status).toBe(400);
    expect((await post(db, '/api/sync', { pushedEntries: [{ id: 'x', reps: 999 }], sinceCursor: 0 }, USER_ONE_TOKEN)).status).toBe(400);
    expect((await post(db, '/api/sync', { pushedEntries: [], sinceCursor: -1 }, USER_ONE_TOKEN)).status).toBe(400);
    expect((await post(db, '/api/sync', { pushedEntries: [] }, USER_ONE_TOKEN)).status).toBe(400);
    expect((await post(db, '/api/invite', { kind: 'admin' }, USER_ONE_TOKEN)).status).toBe(400);
    expect((await route({ method: 'GET', path: '/api/sync', headers: {}, body: '' }, { db })).status).toBe(405);
    expect((await post(db, '/api/other', {}, USER_ONE_TOKEN)).status).toBe(404);
  });

  it('a friend invite creates a new account, once', async () => {
    const db = setup();
    const invited = await post(db, '/api/invite', { kind: 'friend' }, USER_ONE_TOKEN);
    const code = (invited.body as { code: string }).code;
    expect((await post(db, '/api/join', { code, name: '   ' })).status).toBe(400);
    const joined = await post(db, '/api/join', { code, name: '  Sam  ' });
    expect(joined).toMatchObject({ status: 200, body: { account: { name: 'Sam' } } });
    const { token, account } = joined.body as { token: string; account: { id: string } };
    expect(account.id).not.toMatch(/^u[12]$/);
    expect(await post(db, '/api/sync', { pushedEntries: [], sinceCursor: 0 }, token)).toMatchObject({ status: 200, body: { account } });
    expect((await post(db, '/api/join', { code, name: 'Sam again' })).status).toBe(410);
  });

  it('a device link signs into the same account and expires', async () => {
    const db = setup();
    const startMs = Date.now();
    await post(db, '/api/sync', { pushedEntries: [makeEntry(OCT8, 4)], sinceCursor: 0 }, USER_ONE_TOKEN);
    const link = (await createInvite(db, 'u1', 'device', { now: () => startMs })).code;
    const joined = await post(db, '/api/join', { code: link }, undefined, () => startMs + 1000);
    const { token } = joined.body as { token: string };
    const synced = await post(db, '/api/sync', { pushedEntries: [], sinceCursor: 0 }, token);
    expect(synced).toMatchObject({ status: 200, body: { account: { id: 'u1' } } });
    expect((synced.body as { entries: unknown[] }).entries).toHaveLength(1);

    const late = (await createInvite(db, 'u1', 'device', { now: () => startMs })).code;
    expect((await post(db, '/api/join', { code: late }, undefined, () => startMs + DEVICE_LINK_TTL_MS)).status).toBe(410);
  });

  it('rejects a code that was never issued', async () => {
    expect((await post(setup(), '/api/join', { code: 'never-issued-code-0123456789', name: 'X' })).status).toBe(410);
    expect((await post(setup(), '/api/join', { code: 'short', name: 'X' })).status).toBe(400);
  });
});
