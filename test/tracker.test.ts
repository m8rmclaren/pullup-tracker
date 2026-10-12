import { beforeEach, describe, expect, it } from 'vitest';
import { hashToken } from '../src/lambda/auth';
import { MemoryDb } from '../src/lambda/db';
import { route } from '../src/lambda/http';
import { syncEntries } from '../src/lambda/sync';
import type { Entry, SyncRequest, SyncResponse } from '../src/shared/model';
import { computeStats } from '../src/shared/stats';
import { HttpError, type KeyValueStorage, Tracker, type Transport, backoffMs } from '../src/app/tracker';

class MemoryStorage implements KeyValueStorage {
  items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
}

/** Manual timers so tests decide when the debounced sync fires. */
class Clock {
  nowMs = Date.parse('2026-10-08T18:00:00Z');
  timers: { callback: () => void; atMs: number }[] = [];
  now = () => this.nowMs;
  setTimer = (callback: () => void, delayMs: number) => {
    const timer = { callback, atMs: this.nowMs + delayMs };
    this.timers.push(timer);
    return timer;
  };
  clearTimer = (handle: unknown) => {
    this.timers = this.timers.filter((timer) => timer !== handle);
  };
  pending() {
    return this.timers.length;
  }
}

let lastIdNumber = 0;
function makeTracker(transport: Transport, storage = new MemoryStorage(), clock = new Clock()) {
  const tracker = new Tracker({ storage, transport, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, newId: () => `t${++lastIdNumber}` });
  tracker.updateSettings({ token: 'tok' });
  return { tracker, storage, clock };
}

const USER_ID = 'u1';
const ACCOUNT = { id: USER_ID, name: 'Me', timeZone: 'America/Denver' };
const EMPTY_RESPONSE: SyncResponse = { entries: [], definitions: [], cursor: 0, account: ACCOUNT };
const SERVER_TOKEN = 'tracker-test-server-token-0123456789';

/** The real route for one account, with the request round-tripped through JSON like the wire. Every device token maps to that account. */
const serveSync = async (db: MemoryDb, request: SyncRequest): Promise<SyncResponse> => {
  if (!db.users.has(USER_ID)) {
    db.users.set(USER_ID, { id: USER_ID, name: 'Me', createdAt: 1 });
    db.tokens.set(hashToken(SERVER_TOKEN), USER_ID);
  }
  const response = await route({ method: 'POST', path: '/api/sync', headers: { 'x-pullup-token': SERVER_TOKEN }, body: JSON.stringify(request) }, { db });
  if (response.status !== 200) throw new HttpError(response.status, (response.body as { error: string }).error);
  return JSON.parse(JSON.stringify(response.body)) as SyncResponse;
};
const serverTransport = (db: MemoryDb): Transport => (request) => serveSync(db, request);
const storedEntry = (db: MemoryDb, id: string): Entry | undefined => db.entries.get(USER_ID)?.get(id);

describe('Tracker', () => {
  let db: MemoryDb;
  beforeEach(() => {
    db = new MemoryDb();
  });

  it('records a tap locally and persists it before any network', () => {
    const { tracker, storage } = makeTracker(async () => {
      throw new Error('offline');
    });
    tracker.add(6);
    expect(tracker.allEntries()).toHaveLength(1);
    expect(tracker.pendingCount()).toBe(1);
    const reloaded = new Tracker({ storage, transport: async () => EMPTY_RESPONSE });
    expect(reloaded.allEntries()[0]!.reps).toBe(6);
    expect(reloaded.pendingCount()).toBe(1);
  });

  it('batches rapid taps into a single debounced sync', async () => {
    const requests: SyncRequest[] = [];
    const { tracker, clock } = makeTracker(async (request) => {
      requests.push(request);
      return serveSync(db, request);
    });
    clock.timers = [];
    tracker.add(5);
    tracker.add(5);
    tracker.add(4);
    expect(clock.pending()).toBe(1);
    await tracker.syncNow();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.pushedEntries).toHaveLength(3);
    expect(tracker.pendingCount()).toBe(0);
    expect(tracker.status).toBe('synced');
  });

  it('keeps an entry queued if it was edited while its push was in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { tracker } = makeTracker(async (request) => {
      await gate;
      return serveSync(db, request);
    });
    const entry = tracker.add(5);
    const syncInFlight = tracker.syncNow();
    tracker.update(entry.id, { reps: 8 });
    release();
    await syncInFlight;
    expect(tracker.getEntry(entry.id)!.reps).toBe(8);
    expect(tracker.pendingCount()).toBe(1);
    await tracker.syncNow();
    expect(tracker.pendingCount()).toBe(0);
    expect(storedEntry(db, entry.id)!.reps).toBe(8);
  });

  it('two devices converge, including an edit and a delete made offline', async () => {
    const deviceA = makeTracker(serverTransport(db));
    const deviceB = makeTracker(serverTransport(db));
    const setA = deviceA.tracker.add(5);
    const setB = deviceB.tracker.add(7);
    await deviceA.tracker.syncNow();
    await deviceB.tracker.syncNow();
    await deviceA.tracker.syncNow();
    expect(deviceA.tracker.allEntries().length).toBe(2);

    deviceA.clock.nowMs += 1000;
    deviceB.clock.nowMs += 2000;
    deviceA.tracker.update(setB.id, { reps: 6 }); // A edits B's set…
    deviceB.tracker.remove(setB.id); // …while B deletes it, later
    deviceB.tracker.update(setA.id, { reps: 4 });
    await deviceA.tracker.syncNow();
    await deviceB.tracker.syncNow();
    await deviceA.tracker.syncNow();

    const sortedEntries = (tracker: Tracker) => tracker.allEntries().sort((a, b) => (a.id < b.id ? -1 : 1));
    expect(sortedEntries(deviceA.tracker)).toEqual(sortedEntries(deviceB.tracker));
    expect(deviceA.tracker.getEntry(setB.id)!.deleted).toBe(true);
    expect(deviceA.tracker.getEntry(setA.id)!.reps).toBe(4);
  });

  it('a fresh device with cleared storage pulls the full history', async () => {
    const deviceA = makeTracker(serverTransport(db));
    deviceA.tracker.add(5);
    deviceA.tracker.add(6, Date.parse('2026-09-15T18:00:00Z'));
    await deviceA.tracker.syncNow();
    const fresh = makeTracker(serverTransport(db));
    await fresh.tracker.syncNow();
    expect(fresh.tracker.allEntries().map((entry) => entry.reps).sort()).toEqual([5, 6]);
  });

  it('sends its cursor, and starts over from 0 when the token changes', async () => {
    const sentCursors: number[] = [];
    const { tracker } = makeTracker(async (request) => {
      sentCursors.push(request.sinceCursor);
      return { ...(await serveSync(db, request)), cursor: 1234 };
    });
    await tracker.syncNow();
    await tracker.syncNow();
    expect(tracker.account).toEqual(ACCOUNT);
    tracker.updateSettings({ token: 'another' });
    expect(tracker.account).toBeNull();
    await tracker.syncNow();
    expect(sentCursors).toEqual([0, 1234, 0]);
  });

  it('signing in keeps sets logged before joining and pushes them', async () => {
    const { tracker } = makeTracker(serverTransport(db));
    tracker.updateSettings({ token: '' });
    const entry = tracker.add(6);
    await tracker.syncNow();
    expect(tracker.status).toBe('unconfigured');
    tracker.signIn('fresh-token', ACCOUNT);
    expect(tracker.account).toEqual(ACCOUNT);
    await tracker.syncNow();
    expect(storedEntry(db, entry.id)!.reps).toBe(6);
  });

  it('an undo before the first sync still reaches the server as a tombstone', async () => {
    const { tracker } = makeTracker(serverTransport(db));
    const entry = tracker.add(5);
    tracker.remove(entry.id);
    await tracker.syncNow();
    expect(storedEntry(db, entry.id)!.deleted).toBe(true);
  });

  it('backs off on network failure and stops on a rejected token', async () => {
    let mode: 'down' | 'auth' = 'down';
    const { tracker, clock } = makeTracker(async () => {
      throw mode === 'down' ? new TypeError('Failed to fetch') : new HttpError(401, 'bad token');
    });
    tracker.add(5);
    clock.timers = [];
    await tracker.syncNow();
    expect(tracker.status).toBe('offline');
    expect(clock.timers[0]!.atMs - clock.nowMs).toBe(backoffMs(1));
    await tracker.syncNow();
    expect(clock.timers.at(-1)!.atMs - clock.nowMs).toBe(backoffMs(2));
    expect(tracker.pendingCount()).toBe(1);

    mode = 'auth';
    clock.timers = [];
    await tracker.syncNow();
    expect(tracker.status).toBe('auth');
    expect(clock.pending()).toBe(0);
  });

  it('speaks protocol v2, and stops syncing for good when the server turns its version away', async () => {
    const requests: SyncRequest[] = [];
    let isOutdated = false;
    const { tracker, clock } = makeTracker(async (request) => {
      requests.push(request);
      if (isOutdated) throw new HttpError(426, 'Update the app to keep syncing.');
      return serveSync(db, request);
    });
    tracker.add(5);
    await tracker.syncNow();
    expect(requests[0]!.protocolVersion).toBe(2);

    isOutdated = true;
    tracker.add(6);
    clock.timers = [];
    await tracker.syncNow();
    expect(tracker.status).toBe('outdated');
    expect(tracker.lastError).toMatch(/Reload to update/);
    expect(clock.pending()).toBe(0);
    tracker.add(7);
    await tracker.syncNow();
    expect(requests).toHaveLength(2);
    expect(tracker.status).toBe('outdated');
    expect(tracker.pendingCount()).toBe(2);
  });

  it('editing a set from a newer client keeps the fields this UI doesn’t show', async () => {
    const chinUp: Entry = { id: 'v2a', doneAt: Date.parse('2026-10-08T15:00:00Z'), updatedAt: 1, exerciseId: 'chin-up', variationIds: ['band', 'negative'], reps: 5 };
    const lever: Entry = { id: 'v2b', doneAt: Date.parse('2026-10-08T15:05:00Z'), updatedAt: 1, exerciseId: 'front-lever', variationIds: ['tuck'], holdSeconds: 20 };
    await syncEntries(db, USER_ID, 'America/Denver', [chinUp, lever], 0);
    const { tracker } = makeTracker(serverTransport(db));
    await tracker.syncNow();

    tracker.update(chinUp.id, { reps: 6, addedWeightLbs: 10 });
    tracker.update(lever.id, { holdSeconds: 25, reps: 99, doneAt: lever.doneAt + 60_000 });
    await tracker.syncNow();
    expect(storedEntry(db, chinUp.id)).toMatchObject({ exerciseId: 'chin-up', variationIds: ['band', 'negative'], reps: 6, addedWeightLbs: 10 });
    expect(storedEntry(db, lever.id)).toMatchObject({ exerciseId: 'front-lever', variationIds: ['tuck'], holdSeconds: 25, doneAt: lever.doneAt + 60_000 });
    expect(storedEntry(db, lever.id)).not.toHaveProperty('reps');

    tracker.remove(lever.id);
    tracker.restore(lever.id);
    await tracker.syncNow();
    expect(storedEntry(db, lever.id)).toMatchObject({ exerciseId: 'front-lever', holdSeconds: 25 });
    expect(storedEntry(db, lever.id)).not.toHaveProperty('deleted');
  });

  it('creates an exercise and logs to it offline, then syncs both, and other devices see it', async () => {
    let isOnline = false;
    const { tracker, clock } = makeTracker(async (request) => {
      if (!isOnline) throw new TypeError('Failed to fetch');
      return serveSync(db, request);
    });
    const stairs = tracker.createExercise({ name: 'Red Rocks stairs', measure: 'count', unit: 'lap', description: 'Bottom to top' });
    const typewriters = tracker.createExercise({ name: 'Archer typewriters', measure: 'count', unit: 'rep' });
    const wallSit = tracker.createExercise({ name: 'Wall sit', measure: 'time' });
    const intoTuck = tracker.createVariation('muscle-up', 'Into tuck');
    expect(stairs.id).toMatch(/^x-[a-z2-7]{16}$/);
    expect(intoTuck.id).toMatch(/^v-[a-z2-7]{16}$/);
    tracker.log({ exerciseId: stairs.id, reps: 3 });
    tracker.log({ exerciseId: typewriters.id, reps: 10 });
    tracker.log({ exerciseId: wallSit.id, holdSeconds: 90 });
    tracker.log({ exerciseId: 'muscle-up', variationIds: [intoTuck.id], reps: 2 });
    tracker.add(8);
    await tracker.syncNow();
    expect(tracker.pendingCount()).toBe(9);

    isOnline = true;
    await tracker.syncNow();
    expect(tracker.pendingCount()).toBe(0);
    expect(db.definitions.get(stairs.id)).toMatchObject({ name: 'Red Rocks stairs', createdBy: USER_ID });
    expect(tracker.allDefinitions().every((definition) => definition.createdBy === USER_ID)).toBe(true);

    const otherDevice = makeTracker(serverTransport(db)).tracker;
    await otherDevice.syncNow();
    expect(otherDevice.exercise(stairs.id)).toMatchObject({ name: 'Red Rocks stairs', unit: 'lap' });
    expect(otherDevice.variationName('muscle-up', intoTuck.id)).toBe('Into tuck');
    // The ring counts the pull-ups, muscle-ups and the created rep-unit exercise; not laps, not the hold.
    const ringReps = computeStats(otherDevice.allEntries(), clock.nowMs, 35, 'America/Denver', (exerciseId) => otherDevice.exercise(exerciseId)?.unit).today.reps;
    expect(ringReps).toBe(8 + 10 + 2);
    expect(db.dayTotals.get(USER_ID)!.get('2026-10-08')).toMatchObject({ reps: ringReps, sets: 5, holdSeconds: 90 });
  });

  it('renames a created exercise on one device and the other picks it up', async () => {
    const deviceA = makeTracker(serverTransport(db)).tracker;
    const deviceB = makeTracker(serverTransport(db)).tracker;
    const stairs = deviceA.createExercise({ name: 'Stairs', measure: 'count', unit: 'lap' });
    await deviceA.syncNow();
    await deviceB.syncNow();
    deviceA.editDefinition(deviceA.allDefinitions()[0]!, { name: 'Red Rocks stairs', description: 'Bottom to top' });
    await deviceA.syncNow();
    await deviceB.syncNow();
    expect(deviceB.exercise(stairs.id)).toMatchObject({ name: 'Red Rocks stairs', description: 'Bottom to top' });
  });

  it('never lets a device clock that went backwards lose an edit', () => {
    const { tracker, clock } = makeTracker(async () => EMPTY_RESPONSE);
    const entry = tracker.add(5);
    clock.nowMs -= 60_000;
    const edited = tracker.update(entry.id, { reps: 7 })!;
    expect(edited.updatedAt).toBeGreaterThan(entry.updatedAt);
  });

  it('logs, edits and clears added weight, and syncs it', async () => {
    const { tracker } = makeTracker(serverTransport(db));
    const entry = tracker.add(5, undefined, 25);
    expect(entry.addedWeightLbs).toBe(25);
    expect(tracker.update(entry.id, { reps: 4 })!.addedWeightLbs).toBe(25);
    await tracker.syncNow();
    const fresh = makeTracker(serverTransport(db)).tracker;
    await fresh.syncNow();
    expect(fresh.getEntry(entry.id)!.addedWeightLbs).toBe(25);
    expect('addedWeightLbs' in tracker.update(entry.id, { addedWeightLbs: 0 })!).toBe(false);
    expect('addedWeightLbs' in tracker.add(5)).toBe(false);
  });

  it('the pad weight expires at the end of the day it was chosen', () => {
    const { tracker } = makeTracker(async () => EMPTY_RESPONSE);
    tracker.setPadAddedWeight(45, '2026-10-08');
    expect(tracker.padAddedWeightLbs('2026-10-08')).toBe(45);
    expect(tracker.padAddedWeightLbs('2026-10-09')).toBe(0);
  });
});

describe('backoffMs', () => {
  it('doubles from 2s and caps at 5 minutes', () => {
    expect([1, 2, 3].map(backoffMs)).toEqual([2000, 4000, 8000]);
    expect(backoffMs(20)).toBe(300_000);
  });
});

describe('Tracker time zone', () => {
  const db = new MemoryDb();
  it('keeps days in the account’s zone, Denver for an account from before zones, and the device’s before joining', () => {
    const storage = new MemoryStorage();
    const clock = new Clock();
    const tracker = new Tracker({ storage, transport: serverTransport(db), now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, deviceTimeZone: 'Asia/Kolkata' });
    expect(tracker.timeZone()).toBe('Asia/Kolkata');
    tracker.signIn('tok', { id: USER_ID, name: 'Me', timeZone: 'Europe/London' });
    expect(tracker.timeZone()).toBe('Europe/London');
    storage.setItem('pullups:v1', JSON.stringify({ version: 1, entries: [], outbox: [], cursor: 5, account: { id: USER_ID, name: 'Me' }, settings: { token: 'tok', goal: 35 }, lastSyncAt: null }));
    const restored = new Tracker({ storage, transport: serverTransport(db), now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, deviceTimeZone: 'Asia/Kolkata' });
    expect(restored.timeZone()).toBe('America/Denver');
  });
});
