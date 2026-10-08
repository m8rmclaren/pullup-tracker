import { describe, expect, it } from 'vitest';
import type { Entry } from '../src/shared/model';
import { DEVICE_LINK_MS, createInvite } from '../src/lambda/accounts';
import { hashToken } from '../src/lambda/auth';
import { type StoredEntry, MemoryDb } from '../src/lambda/db';
import { route } from '../src/lambda/http';
import { LAG_MS, handleSync, recomputeDay } from '../src/lambda/sync';

const OCT8 = Date.parse('2026-10-08T18:00:00Z');
const OCT9 = Date.parse('2026-10-09T18:00:00Z');
const U = 'u1';
let n = 0;
const e = (ts: number, reps = 5, extra: Partial<Entry> = {}): Entry => ({ id: `id${++n}`, ts, reps, updatedAt: 1, ...extra });
const tick = () => new Promise((r) => setTimeout(r, 1));

/** Yields around every read and write so concurrent requests interleave the worst way. */
class InterleavingDb extends MemoryDb {
  override async getEntries(uid: string, ids: string[]) {
    await tick();
    const v = await super.getEntries(uid, ids);
    await tick();
    return v;
  }
  override async entriesBetween(uid: string, from: number, to: number) {
    const v = await super.entriesBetween(uid, from, to);
    await tick();
    return v;
  }
  override async getDay(uid: string, day: string) {
    const v = await super.getDay(uid, day);
    await tick();
    return v;
  }
}

describe('handleSync', () => {
  it('returns everything on a first sync, then only what was written since the cursor', async () => {
    const db = new MemoryDb();
    let t = OCT8;
    const clock = { now: () => t };
    const a = e(OCT8);
    const r1 = await handleSync(db, U, [a], 0, clock);
    expect(r1.entries).toEqual([a]);
    expect(r1.cursor).toBe(OCT8 - LAG_MS);

    // Each write was younger than the lag when the cursor was cut, so it comes back once more.
    t += 10 * 60_000;
    const b = e(OCT8 + 1);
    const r2 = await handleSync(db, U, [b], r1.cursor, clock);
    expect(r2.entries).toEqual([a, b]);

    t += 10 * 60_000;
    const r3 = await handleSync(db, U, [], r2.cursor, clock);
    expect(r3.entries).toEqual([b]);

    t += 10 * 60_000;
    expect((await handleSync(db, U, [], r3.cursor, clock)).entries).toEqual([]);
  });

  it('still delivers a write that commits after a later sync has started', async () => {
    let t = OCT8;
    const clock = { now: () => t };
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    class SlowDb extends MemoryDb {
      override async putEntry(uid: string, x: StoredEntry, prev: number | null) {
        await gate;
        return super.putEntry(uid, x, prev);
      }
    }
    const db = new SlowDb();
    const slow = handleSync(db, U, [e(OCT8)], 0, clock); // stamped at t, not yet committed
    await tick();
    t += 5000;
    const reader = await handleSync(new MemoryDb(), U, [], 0, clock); // cursor from another, faster request
    release();
    await slow;
    expect((await handleSync(db, U, [], reader.cursor, clock)).entries).toHaveLength(1);
  });

  it('keeps day totals for the leaderboard, through edits, deletes and moves between days', async () => {
    const db = new MemoryDb();
    const a = e(OCT8, 5);
    const b = e(OCT8, 8, { lbs: 25 });
    await handleSync(db, U, [a, b], 0);
    expect(await db.getDay(U, '2026-10-08')).toMatchObject({ reps: 13, sets: 2, best: 8 });

    await handleSync(db, U, [{ ...a, deleted: true, updatedAt: 2 }], 0);
    expect(await db.getDay(U, '2026-10-08')).toMatchObject({ reps: 8, sets: 1, best: 8 });

    await handleSync(db, U, [{ ...b, ts: OCT9, updatedAt: 2 }], 0);
    expect(await db.getDay(U, '2026-10-08')).toMatchObject({ reps: 0, sets: 0 });
    expect(await db.getDay(U, '2026-10-09')).toMatchObject({ reps: 8, sets: 1 });
  });

  it('heals a day total when a retried push finds its entry already written', async () => {
    const db = new MemoryDb();
    const a = e(OCT8, 7);
    // As if a request wrote the entry and then timed out before totalling the day.
    await db.putEntry(U, { ...a, srv: 1 }, null);
    await handleSync(db, U, [a], 0);
    expect(await db.getDay(U, '2026-10-08')).toMatchObject({ reps: 7 });
  });

  it('loses no sets, and no reps from the total, when many devices push at once', async () => {
    const db = new InterleavingDb();
    const pushes = Array.from({ length: 12 }, (_, i) => [e(OCT8 + i * 1000, (i % 6) + 3)]);
    await Promise.all(pushes.map((push) => handleSync(db, U, push, 0)));
    const all = (await handleSync(db, U, [], 0)).entries;
    expect(all).toHaveLength(12);
    expect((await db.getDay(U, '2026-10-08'))!.reps).toBe(all.reduce((s, x) => s + x.reps, 0));
  });

  it('a concurrent edit and delete converge to the newer one', async () => {
    const db = new InterleavingDb();
    const base = e(OCT8, 5);
    await handleSync(db, U, [base], 0);
    await Promise.all([handleSync(db, U, [{ ...base, reps: 7, updatedAt: 10 }], 0), handleSync(db, U, [{ ...base, deleted: true, updatedAt: 11 }], 0)]);
    expect((await handleSync(db, U, [], 0)).entries).toEqual([{ ...base, deleted: true, updatedAt: 11 }]);
    expect(await db.getDay(U, '2026-10-08')).toMatchObject({ reps: 0, sets: 0 });
  });

  it('ignores a stale version and does not rewrite the entry', async () => {
    const db = new MemoryDb();
    const a = e(OCT8, 5, { updatedAt: 10 });
    await handleSync(db, U, [a], 0);
    const srv = db.entries.get(U)!.get(a.id)!.srv;
    await handleSync(db, U, [{ ...a, reps: 9, updatedAt: 3 }], 0);
    expect(db.entries.get(U)!.get(a.id)).toMatchObject({ reps: 5, srv });
  });

  it('a stale recompute cannot overwrite a newer total', async () => {
    const db = new InterleavingDb();
    await handleSync(db, U, [e(OCT8, 5)], 0);
    await Promise.all([recomputeDay(db, U, '2026-10-08'), handleSync(db, U, [e(OCT8, 6)], 0), recomputeDay(db, U, '2026-10-08')]);
    expect((await db.getDay(U, '2026-10-08'))!.reps).toBe(11);
  });
});

describe('route', () => {
  const T1 = 'device-token-for-user-one-0123456789';
  const T2 = 'device-token-for-user-two-0123456789';
  const setup = () => {
    const db = new MemoryDb();
    db.users.set('u1', { id: 'u1', name: 'One', createdAt: 1 });
    db.users.set('u2', { id: 'u2', name: 'Two', createdAt: 1 });
    db.tokens.set(hashToken(T1), 'u1');
    db.tokens.set(hashToken(T2), 'u2');
    return db;
  };
  const post = (db: MemoryDb, path: string, body: unknown, token?: string, now = Date.now) =>
    route({ method: 'POST', path, headers: token ? { 'x-pullup-token': token } : {}, body: JSON.stringify(body) }, { db, clock: { now } });

  it('syncs per account, and one user never sees another user’s sets', async () => {
    const db = setup();
    const mine = e(OCT8, 9);
    const r1 = await post(db, '/api/sync', { push: [mine], since: 0 }, T1);
    expect(r1).toMatchObject({ status: 200, body: { entries: [mine], me: { id: 'u1', name: 'One' } } });
    const r2 = await post(db, '/api/sync', { push: [], since: 0 }, T2);
    expect(r2).toMatchObject({ status: 200, body: { entries: [], me: { id: 'u2' } } });
  });

  it('rejects a missing or unknown token before touching storage', async () => {
    const db = setup();
    expect((await post(db, '/api/sync', { push: [e(OCT8)], since: 0 })).status).toBe(401);
    expect((await post(db, '/api/sync', { push: [e(OCT8)], since: 0 }, T1 + 'x')).status).toBe(401);
    expect((await post(db, '/api/invite', { kind: 'friend' })).status).toBe(401);
    expect(db.entries.size).toBe(0);
  });

  it('rejects invalid bodies and unknown routes', async () => {
    const db = setup();
    expect((await route({ method: 'POST', path: '/api/sync', headers: { 'x-pullup-token': T1 }, body: '{' }, { db })).status).toBe(400);
    expect((await post(db, '/api/sync', { push: [{ id: 'x', reps: 999 }], since: 0 }, T1)).status).toBe(400);
    expect((await post(db, '/api/sync', { push: [], since: -1 }, T1)).status).toBe(400);
    expect((await post(db, '/api/sync', { push: [] }, T1)).status).toBe(400);
    expect((await post(db, '/api/invite', { kind: 'admin' }, T1)).status).toBe(400);
    expect((await route({ method: 'GET', path: '/api/sync', headers: {}, body: '' }, { db })).status).toBe(405);
    expect((await post(db, '/api/other', {}, T1)).status).toBe(404);
  });

  it('a friend invite creates a new account, once', async () => {
    const db = setup();
    const inv = await post(db, '/api/invite', { kind: 'friend' }, T1);
    const code = (inv.body as { code: string }).code;
    expect((await post(db, '/api/join', { code, name: '   ' })).status).toBe(400);
    const joined = await post(db, '/api/join', { code, name: '  Sam  ' });
    expect(joined).toMatchObject({ status: 200, body: { me: { name: 'Sam' } } });
    const { token, me } = joined.body as { token: string; me: { id: string } };
    expect(me.id).not.toMatch(/^u[12]$/);
    expect(await post(db, '/api/sync', { push: [], since: 0 }, token)).toMatchObject({ status: 200, body: { me } });
    expect((await post(db, '/api/join', { code, name: 'Sam again' })).status).toBe(410);
  });

  it('a device link signs into the same account and expires', async () => {
    const db = setup();
    const t0 = Date.now();
    await post(db, '/api/sync', { push: [e(OCT8, 4)], since: 0 }, T1);
    const link = (await createInvite(db, 'u1', 'device', { now: () => t0 })).code;
    const joined = await post(db, '/api/join', { code: link }, undefined, () => t0 + 1000);
    const { token } = joined.body as { token: string };
    const synced = await post(db, '/api/sync', { push: [], since: 0 }, token);
    expect(synced).toMatchObject({ status: 200, body: { me: { id: 'u1' } } });
    expect((synced.body as { entries: unknown[] }).entries).toHaveLength(1);

    const late = (await createInvite(db, 'u1', 'device', { now: () => t0 })).code;
    expect((await post(db, '/api/join', { code: late }, undefined, () => t0 + DEVICE_LINK_MS)).status).toBe(410);
  });

  it('rejects a code that was never issued', async () => {
    expect((await post(setup(), '/api/join', { code: 'never-issued-code-0123456789', name: 'X' })).status).toBe(410);
    expect((await post(setup(), '/api/join', { code: 'short', name: 'X' })).status).toBe(400);
  });
});
