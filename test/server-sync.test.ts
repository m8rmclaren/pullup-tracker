import { describe, expect, it } from 'vitest';
import type { Entry } from '../src/shared/model';
import { DEVICE_LINK_TTL_MS, createInvite } from '../src/lambda/accounts';
import { hashToken } from '../src/lambda/auth';
import { type StoredEntry, MemoryDb } from '../src/lambda/db';
import { route } from '../src/lambda/http';
import { CURSOR_LAG_MS, syncEntries, recomputeDayTotal } from '../src/lambda/sync';
import { type StatsFixtureCase, loadFixture, toEntries } from './fixtures';

const OCT8 = Date.parse('2026-10-08T18:00:00Z');
const OCT9 = Date.parse('2026-10-09T18:00:00Z');
const USER_ID = 'u1';
const DENVER = 'America/Denver';
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
    const firstSync = await syncEntries(db, USER_ID, DENVER, [first], 0, clock);
    expect(firstSync.entries).toEqual([first]);
    expect(firstSync.cursor).toBe(OCT8 - CURSOR_LAG_MS);

    // Each write was younger than the lag when the cursor was cut, so it comes back once more.
    nowMs += 10 * 60_000;
    const second = makeEntry(OCT8 + 1);
    const secondSync = await syncEntries(db, USER_ID, DENVER, [second], firstSync.cursor, clock);
    expect(secondSync.entries).toEqual([first, second]);

    nowMs += 10 * 60_000;
    const thirdSync = await syncEntries(db, USER_ID, DENVER, [], secondSync.cursor, clock);
    expect(thirdSync.entries).toEqual([second]);

    nowMs += 10 * 60_000;
    expect((await syncEntries(db, USER_ID, DENVER, [], thirdSync.cursor, clock)).entries).toEqual([]);
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
    const slow = syncEntries(db, USER_ID, DENVER, [makeEntry(OCT8)], 0, clock); // stamped at nowMs, not yet committed
    await tick();
    nowMs += 5000;
    const reader = await syncEntries(new MemoryDb(), USER_ID, DENVER, [], 0, clock); // cursor from another, faster request
    release();
    await slow;
    expect((await syncEntries(db, USER_ID, DENVER, [], reader.cursor, clock)).entries).toHaveLength(1);
  });

  it('keeps day totals for the leaderboard, through edits, deletes and moves between days', async () => {
    const db = new MemoryDb();
    const first = makeEntry(OCT8, 5);
    const second = makeEntry(OCT8, 8, { addedWeightLbs: 25 });
    await syncEntries(db, USER_ID, DENVER, [first, second], 0);
    expect(await db.getDayTotal(USER_ID, '2026-10-08')).toMatchObject({ reps: 13, sets: 2, bestSetReps: 8 });

    await syncEntries(db, USER_ID, DENVER, [{ ...first, deleted: true, updatedAt: 2 }], 0);
    expect(await db.getDayTotal(USER_ID, '2026-10-08')).toMatchObject({ reps: 8, sets: 1, bestSetReps: 8 });

    await syncEntries(db, USER_ID, DENVER, [{ ...second, doneAt: OCT9, updatedAt: 2 }], 0);
    expect(await db.getDayTotal(USER_ID, '2026-10-08')).toMatchObject({ reps: 0, sets: 0 });
    expect(await db.getDayTotal(USER_ID, '2026-10-09')).toMatchObject({ reps: 8, sets: 1 });
  });

  it('heals a day total when a retried push finds its entry already written', async () => {
    const db = new MemoryDb();
    const entry = makeEntry(OCT8, 7);
    // As if a request wrote the entry and then timed out before totalling the day.
    await db.putEntry(USER_ID, { ...entry, serverWrittenAt: 1 }, null);
    await syncEntries(db, USER_ID, DENVER, [entry], 0);
    expect(await db.getDayTotal(USER_ID, '2026-10-08')).toMatchObject({ reps: 7 });
  });

  it('loses no sets, and no reps from the total, when many devices push at once', async () => {
    const db = new InterleavingDb();
    const pushes = Array.from({ length: 12 }, (_, i) => [makeEntry(OCT8 + i * 1000, (i % 6) + 3)]);
    await Promise.all(pushes.map((pushedEntries) => syncEntries(db, USER_ID, DENVER, pushedEntries, 0)));
    const allEntries = (await syncEntries(db, USER_ID, DENVER, [], 0)).entries;
    expect(allEntries).toHaveLength(12);
    expect((await db.getDayTotal(USER_ID, '2026-10-08'))!.reps).toBe(allEntries.reduce((reps, entry) => reps + entry.reps!, 0));
  });

  it('a concurrent edit and delete converge to the newer one', async () => {
    const db = new InterleavingDb();
    const base = makeEntry(OCT8, 5);
    await syncEntries(db, USER_ID, DENVER, [base], 0);
    await Promise.all([syncEntries(db, USER_ID, DENVER, [{ ...base, reps: 7, updatedAt: 10 }], 0), syncEntries(db, USER_ID, DENVER, [{ ...base, deleted: true, updatedAt: 11 }], 0)]);
    expect((await syncEntries(db, USER_ID, DENVER, [], 0)).entries).toEqual([{ ...base, deleted: true, updatedAt: 11 }]);
    expect(await db.getDayTotal(USER_ID, '2026-10-08')).toMatchObject({ reps: 0, sets: 0 });
  });

  it('ignores a stale version and does not rewrite the entry', async () => {
    const db = new MemoryDb();
    const entry = makeEntry(OCT8, 5, { updatedAt: 10 });
    await syncEntries(db, USER_ID, DENVER, [entry], 0);
    const serverWrittenAt = db.entries.get(USER_ID)!.get(entry.id)!.serverWrittenAt;
    await syncEntries(db, USER_ID, DENVER, [{ ...entry, reps: 9, updatedAt: 3 }], 0);
    expect(db.entries.get(USER_ID)!.get(entry.id)).toMatchObject({ reps: 5, serverWrittenAt });
  });

  it('a stale recompute cannot overwrite a newer total', async () => {
    const db = new InterleavingDb();
    await syncEntries(db, USER_ID, DENVER, [makeEntry(OCT8, 5)], 0);
    await Promise.all([recomputeDayTotal(db, USER_ID, '2026-10-08', DENVER), syncEntries(db, USER_ID, DENVER, [makeEntry(OCT8, 6)], 0), recomputeDayTotal(db, USER_ID, '2026-10-08', DENVER)]);
    expect((await db.getDayTotal(USER_ID, '2026-10-08'))!.reps).toBe(11);
  });
});

describe('day totals and the ring', () => {
  it('sums only rep-unit counted sets into reps and bestSetReps, and counts every set', async () => {
    const db = new MemoryDb();
    await syncEntries(db, USER_ID, DENVER, [
      makeEntry(OCT8, 8),
      makeEntry(OCT8, 20, { exerciseId: 'push-up' }),
      { id: 'hold1', doneAt: OCT8, updatedAt: 1, exerciseId: 'plank', holdSeconds: 600 },
      makeEntry(OCT8, 50, { exerciseId: 'x-k3p7abcdefgh2345' }),
    ], 0);
    expect(await db.getDayTotal(USER_ID, '2026-10-08')).toEqual({
      day: '2026-10-08',
      reps: 28,
      sets: 4,
      bestSetReps: 20,
      holdSeconds: 600,
      byExercise: {
        'pull-up': { sets: 1, reps: 8, bestSetReps: 8 },
        'push-up': { sets: 1, reps: 20, bestSetReps: 20 },
        plank: { sets: 1, holdSeconds: 600, bestHoldSeconds: 600 },
        'x-k3p7abcdefgh2345': { sets: 1, reps: 50, bestSetReps: 50 },
      },
      version: 1,
    });
  });

  it('rewrites a pre-v2 total in the v2 shape on the next change to that day', async () => {
    const db = new MemoryDb();
    const first = makeEntry(OCT8, 6);
    await db.putEntry(USER_ID, { ...first, serverWrittenAt: 1 }, null);
    await db.putDayTotal(USER_ID, { day: '2026-10-08', reps: 6, sets: 1, bestSetReps: 6, version: 3 }, null);
    await syncEntries(db, USER_ID, DENVER, [makeEntry(OCT8, 4, { addedWeightLbs: 25 })], 0);
    expect(await db.getDayTotal(USER_ID, '2026-10-08')).toEqual({ day: '2026-10-08', reps: 10, sets: 2, bestSetReps: 6, holdSeconds: 0, byExercise: { 'pull-up': { sets: 2, reps: 10, bestSetReps: 6, bestAddedWeightLbs: 25 } }, version: 4 });
  });
});

describe('per-user time zones', () => {
  it('keys day totals by the user’s own day', async () => {
    const db = new MemoryDb();
    // 23:30 in London on Oct 8 is 17:30 in Denver; 00:30 in London on Oct 9 is still Oct 8 in Denver.
    const lateEvening = makeEntry(Date.parse('2026-10-08T22:30:00Z'), 5);
    const pastMidnight = makeEntry(Date.parse('2026-10-08T23:30:00Z'), 6);
    await syncEntries(db, 'london', 'Europe/London', [lateEvening, pastMidnight], 0);
    await syncEntries(db, 'denver', DENVER, [lateEvening, pastMidnight], 0);
    expect(await db.getDayTotal('london', '2026-10-08')).toMatchObject({ reps: 5, sets: 1 });
    expect(await db.getDayTotal('london', '2026-10-09')).toMatchObject({ reps: 6, sets: 1 });
    expect(await db.getDayTotal('denver', '2026-10-08')).toMatchObject({ reps: 11, sets: 2 });
    expect(await db.getDayTotal('denver', '2026-10-09')).toBeNull();
  });
});

describe('v1 golden history', () => {
  it('stores the same day totals it did in v1', async () => {
    const golden = loadFixture<{ cases: StatsFixtureCase[] }>('stats.json').cases.find((fixtureCase) => fixtureCase.dayTotals)!;
    const db = new MemoryDb();
    await syncEntries(db, USER_ID, DENVER, toEntries(golden.entries), 0);
    const stored = Object.fromEntries([...db.dayTotals.get(USER_ID)!.values()].map(({ day, reps, sets, bestSetReps }) => [day, { reps, sets, bestSetReps }]));
    expect(stored).toEqual(golden.dayTotals);
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
    const userOneSync = await post(db, '/api/sync', { protocolVersion: 2, pushedEntries: [mine], sinceCursor: 0 }, USER_ONE_TOKEN);
    expect(userOneSync).toMatchObject({ status: 200, body: { entries: [mine], account: { id: 'u1', name: 'One' } } });
    const userTwoSync = await post(db, '/api/sync', { protocolVersion: 2, pushedEntries: [], sinceCursor: 0 }, USER_TWO_TOKEN);
    expect(userTwoSync).toMatchObject({ status: 200, body: { entries: [], account: { id: 'u2' } } });
  });

  it('turns away a client that predates protocol v2, before it can write', async () => {
    const db = setup();
    const v1Body = { pushedEntries: [makeEntry(OCT8, 9)], sinceCursor: 0 };
    expect(await post(db, '/api/sync', v1Body, USER_ONE_TOKEN)).toMatchObject({ status: 426, body: { protocolVersion: 2 } });
    expect((await post(db, '/api/sync', { ...v1Body, protocolVersion: 1 }, USER_ONE_TOKEN)).status).toBe(426);
    expect((await post(db, '/api/sync', { ...v1Body, protocolVersion: '2' }, USER_ONE_TOKEN)).status).toBe(426);
    expect((await post(db, '/api/sync', v1Body)).status).toBe(426);
    expect(db.entries.size).toBe(0);
    expect((await post(db, '/api/sync', { ...v1Body, protocolVersion: 2 }, USER_ONE_TOKEN)).status).toBe(200);
  });

  it('stores and returns every v2 field, and keeps a v1-shaped set reading as a pull-up', async () => {
    const db = setup();
    const v1Set = makeEntry(OCT8, 7);
    const chinUp = makeEntry(OCT8, 5, { exerciseId: 'chin-up', variationIds: ['pause', 'band'], addedWeightLbs: 10 });
    const lever: Entry = { id: 'lever1', doneAt: OCT8, updatedAt: 1, exerciseId: 'front-lever', variationIds: ['tuck'], holdSeconds: 45 };
    const synced = await post(db, '/api/sync', { protocolVersion: 2, pushedEntries: [v1Set, chinUp, lever], sinceCursor: 0 }, USER_ONE_TOKEN);
    expect((synced.body as { entries: Entry[] }).entries).toEqual([v1Set, { ...chinUp, variationIds: ['band', 'pause'] }, lever]);
    expect(db.entries.get('u1')!.get(v1Set.id)).not.toHaveProperty('exerciseId');
  });

  it('rejects an entry whose measure doesn’t match its built-in exercise', async () => {
    const db = setup();
    const repsOnAHold = makeEntry(OCT8, 5, { exerciseId: 'plank' });
    expect((await post(db, '/api/sync', { protocolVersion: 2, pushedEntries: [repsOnAHold], sinceCursor: 0 }, USER_ONE_TOKEN)).status).toBe(400);
  });

  it('rejects a missing or unknown token before touching storage', async () => {
    const db = setup();
    expect((await post(db, '/api/sync', { protocolVersion: 2, pushedEntries: [makeEntry(OCT8)], sinceCursor: 0 })).status).toBe(401);
    expect((await post(db, '/api/sync', { protocolVersion: 2, pushedEntries: [makeEntry(OCT8)], sinceCursor: 0 }, USER_ONE_TOKEN + 'x')).status).toBe(401);
    expect((await post(db, '/api/invite', { kind: 'friend' })).status).toBe(401);
    expect(db.entries.size).toBe(0);
  });

  it('rejects invalid bodies and unknown routes', async () => {
    const db = setup();
    expect((await route({ method: 'POST', path: '/api/sync', headers: { 'x-pullup-token': USER_ONE_TOKEN }, body: '{' }, { db })).status).toBe(400);
    expect((await post(db, '/api/sync', { protocolVersion: 2, pushedEntries: [{ id: 'x', reps: 999 }], sinceCursor: 0 }, USER_ONE_TOKEN)).status).toBe(400);
    expect((await post(db, '/api/sync', { protocolVersion: 2, pushedEntries: [], sinceCursor: -1 }, USER_ONE_TOKEN)).status).toBe(400);
    expect((await post(db, '/api/sync', { protocolVersion: 2, pushedEntries: [] }, USER_ONE_TOKEN)).status).toBe(400);
    expect((await post(db, '/api/invite', { kind: 'admin' }, USER_ONE_TOKEN)).status).toBe(400);
    expect((await route({ method: 'GET', path: '/api/sync', headers: {}, body: '' }, { db })).status).toBe(405);
    expect((await post(db, '/api/other', {}, USER_ONE_TOKEN)).status).toBe(404);
  });

  it('keeps a pre-zone account on Denver and reports its zone', async () => {
    const db = setup();
    const lateEvening = makeEntry(Date.parse('2026-10-09T05:30:00Z'), 4); // 23:30 in Denver
    const synced = await post(db, '/api/sync', { protocolVersion: 2, pushedEntries: [lateEvening], sinceCursor: 0 }, USER_ONE_TOKEN);
    expect(synced).toMatchObject({ status: 200, body: { account: { id: 'u1', timeZone: 'America/Denver' } } });
    expect(await db.getDayTotal('u1', '2026-10-08')).toMatchObject({ reps: 4 });
    expect(db.users.get('u1')!.timeZone).toBeUndefined();
  });

  it('a new account takes the device’s zone, or Denver from a client that sends none', async () => {
    const db = setup();
    const inviteCode = async () => ((await post(db, '/api/invite', { kind: 'friend' }, USER_ONE_TOKEN)).body as { code: string }).code;
    const london = await post(db, '/api/join', { code: await inviteCode(), name: 'Ana', timeZone: 'Europe/London' });
    expect(london).toMatchObject({ status: 200, body: { account: { name: 'Ana', timeZone: 'Europe/London' } } });
    const { token } = london.body as { token: string };
    await post(db, '/api/sync', { protocolVersion: 2, pushedEntries: [makeEntry(Date.parse('2026-10-08T23:30:00Z'), 6)], sinceCursor: 0 }, token);
    const londonId = (london.body as { account: { id: string } }).account.id;
    expect(await db.getDayTotal(londonId, '2026-10-09')).toMatchObject({ reps: 6 });

    expect(await post(db, '/api/join', { code: await inviteCode(), name: 'Old client' })).toMatchObject({ status: 200, body: { account: { timeZone: 'America/Denver' } } });
    expect((await post(db, '/api/join', { code: await inviteCode(), name: 'Bad', timeZone: 'Mars/Base' })).status).toBe(400);
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
    expect(await post(db, '/api/sync', { protocolVersion: 2, pushedEntries: [], sinceCursor: 0 }, token)).toMatchObject({ status: 200, body: { account } });
    expect((await post(db, '/api/join', { code, name: 'Sam again' })).status).toBe(410);
  });

  it('a device link signs into the same account and expires', async () => {
    const db = setup();
    const startMs = Date.now();
    await post(db, '/api/sync', { protocolVersion: 2, pushedEntries: [makeEntry(OCT8, 4)], sinceCursor: 0 }, USER_ONE_TOKEN);
    const link = (await createInvite(db, 'u1', 'device', { now: () => startMs })).code;
    const joined = await post(db, '/api/join', { code: link }, undefined, () => startMs + 1000);
    const { token } = joined.body as { token: string };
    const synced = await post(db, '/api/sync', { protocolVersion: 2, pushedEntries: [], sinceCursor: 0 }, token);
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
