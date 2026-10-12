import { describe, expect, it, vi } from 'vitest';
import { hashToken } from '../src/lambda/auth';
import { MemoryDb } from '../src/lambda/db';
import { route } from '../src/lambda/http';
import { ZONE_CHANGE_RECOMPUTE_DAYS, updateProfile } from '../src/lambda/profile';
import { syncEntries } from '../src/lambda/sync';
import type { Entry } from '../src/shared/model';
import { addDays } from '../src/shared/time';

const NOW = Date.parse('2026-10-08T18:00:00Z');
const TOKEN = 'device-token-for-profile-0123456789';
const clock = { now: () => NOW };

function setup() {
  const db = new MemoryDb();
  // As the one production account is today: no zone, goal, clocks or version.
  db.users.set('u1', { id: 'u1', name: 'Hayden', createdAt: 1 });
  db.tokens.set(hashToken(TOKEN), 'u1');
  const post = (path: string, body: unknown, token: string | null = TOKEN) =>
    route({ method: 'POST', path, headers: token ? { 'x-pullup-token': token } : {}, body: JSON.stringify(body) }, { db, clock });
  return { db, post };
}

describe('POST /api/profile', () => {
  it('sets the first goal on a pre-v2 profile, and sync reports it', async () => {
    const { db, post } = setup();
    const updated = await post('/api/profile', { dailyGoalReps: 40, goalUpdatedAt: NOW });
    expect(updated).toEqual({ status: 200, body: { id: 'u1', name: 'Hayden', timeZone: 'America/Denver', dailyGoalReps: 40, goalUpdatedAt: NOW } });
    expect(db.users.get('u1')).toEqual({ id: 'u1', name: 'Hayden', createdAt: 1, dailyGoalReps: 40, goalUpdatedAt: NOW, version: 1 });
    const synced = await post('/api/sync', { protocolVersion: 2, pushedEntries: [], sinceCursor: 0 });
    expect(synced.body).toMatchObject({ account: { id: 'u1', timeZone: 'America/Denver', dailyGoalReps: 40 } });
  });

  it('merges each field last-writer-wins, so edits from two devices both land', async () => {
    const { db, post } = setup();
    await post('/api/profile', { name: 'Hay', nameUpdatedAt: 100 });
    await post('/api/profile', { dailyGoalReps: 50, goalUpdatedAt: 90 });
    const stale = await post('/api/profile', { name: 'Old', nameUpdatedAt: 50, dailyGoalReps: 20, goalUpdatedAt: 80 });
    expect(stale.body).toMatchObject({ name: 'Hay', dailyGoalReps: 50 });
    expect(db.users.get('u1')!.version).toBe(2);
  });

  it('writes concurrent edits of different fields without losing either', async () => {
    const { db } = setup();
    await Promise.all([updateProfile(db, 'u1', { name: 'Hay', nameUpdatedAt: 5 }, clock), updateProfile(db, 'u1', { dailyGoalReps: 30, goalUpdatedAt: 5 }, clock)]);
    expect(db.users.get('u1')).toMatchObject({ name: 'Hay', dailyGoalReps: 30, version: 2 });
  });

  it('rejects bad patches and signed-out devices', async () => {
    const { post } = setup();
    expect((await post('/api/profile', { dailyGoalReps: 40 })).status).toBe(400);
    expect((await post('/api/profile', { timeZone: 'Mars/Base', zoneUpdatedAt: 1 })).status).toBe(400);
    expect((await post('/api/profile', { name: ' x ', nameUpdatedAt: 1 })).status).toBe(400);
    expect((await post('/api/profile', { dailyGoalReps: 40, goalUpdatedAt: 1 }, null)).status).toBe(401);
  });
});

describe('changing time zone', () => {
  const doneAt = (iso: string) => Date.parse(iso);
  let entryCount = 0;
  const makeEntry = (iso: string, reps: number): Entry => ({ id: `z${++entryCount}`, doneAt: doneAt(iso), reps, updatedAt: 1 });

  it('re-keys the last 62 days into the new zone, and leaves older days alone', async () => {
    const { db, post } = setup();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const entries = [
      makeEntry('2026-10-08T03:00:00Z', 5), // Oct 7, 9pm in Denver; Oct 8, 4am in London
      makeEntry('2026-10-07T15:00:00Z', 6), // Oct 7 in both
      makeEntry('2026-06-01T03:00:00Z', 7), // May 31 in Denver; Jun 1 in London, but older than the window
    ];
    await syncEntries(db, 'u1', 'America/Denver', entries, 0, clock);
    expect(await db.getDayTotal('u1', '2026-10-07')).toMatchObject({ reps: 11, sets: 2 });

    const changed = await post('/api/profile', { timeZone: 'Europe/London', zoneUpdatedAt: NOW });
    expect(changed.body).toMatchObject({ timeZone: 'Europe/London', zoneUpdatedAt: NOW });
    expect(await db.getDayTotal('u1', '2026-10-07')).toMatchObject({ reps: 6, sets: 1 });
    expect(await db.getDayTotal('u1', '2026-10-08')).toMatchObject({ reps: 5, sets: 1 });
    expect(await db.getDayTotal('u1', '2026-05-31')).toMatchObject({ reps: 7 });
    expect(await db.getDayTotal('u1', '2026-06-01')).toBeNull();

    // No empty totals for the days in the window without sets.
    expect([...db.dayTotals.get('u1')!.keys()].sort()).toEqual(['2026-05-31', '2026-10-07', '2026-10-08']);
    expect(addDays('2026-10-08', -(ZONE_CHANGE_RECOMPUTE_DAYS - 1)) < '2026-10-07').toBe(true);

    // New sets now land on London days.
    await syncEntries(db, 'u1', 'Europe/London', [makeEntry('2026-10-08T23:30:00Z', 4)], 0, clock);
    expect(await db.getDayTotal('u1', '2026-10-09')).toMatchObject({ reps: 4 });
  });

  it('a retried zone change rebuilds again, healing a request that died partway', async () => {
    const { db, post } = setup();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await syncEntries(db, 'u1', 'America/Denver', [makeEntry('2026-10-08T03:00:00Z', 5)], 0, clock);
    // As if the profile write landed and the Lambda died before re-keying.
    await updateProfile(db, 'u1', { timeZone: 'Europe/London', zoneUpdatedAt: NOW }, clock).catch(() => {});
    db.dayTotals.get('u1')!.set('2026-10-07', { day: '2026-10-07', reps: 5, sets: 1, bestSetReps: 5, version: 1 });
    db.dayTotals.get('u1')!.delete('2026-10-08');
    await post('/api/profile', { timeZone: 'Europe/London', zoneUpdatedAt: NOW });
    expect(await db.getDayTotal('u1', '2026-10-07')).toMatchObject({ reps: 0, sets: 0 });
    expect(await db.getDayTotal('u1', '2026-10-08')).toMatchObject({ reps: 5 });
  });

  it('doesn’t rebuild for a stale zone edit that lost', async () => {
    const { db, post } = setup();
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    await post('/api/profile', { timeZone: 'Europe/London', zoneUpdatedAt: NOW });
    logs.mockClear();
    const stale = await post('/api/profile', { timeZone: 'Asia/Kolkata', zoneUpdatedAt: NOW - 1000 });
    expect(stale.body).toMatchObject({ timeZone: 'Europe/London' });
    expect(logs).not.toHaveBeenCalled();
    expect(db.users.get('u1')!.timeZone).toBe('Europe/London');
  });
});
