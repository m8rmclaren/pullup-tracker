import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryDb } from '../src/lambda/db';
import { syncEntries } from '../src/lambda/sync';
import type { Entry, SyncRequest, SyncResponse } from '../src/shared/model';
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
const ACCOUNT = { id: USER_ID, name: 'Me' };
const EMPTY_RESPONSE: SyncResponse = { entries: [], cursor: 0, account: ACCOUNT };

/** The server's sync logic for one account, with the request round-tripped through JSON like the wire. */
const serveSync = async (db: MemoryDb, request: SyncRequest): Promise<SyncResponse> => {
  const wireRequest = JSON.parse(JSON.stringify(request)) as SyncRequest;
  return { ...(await syncEntries(db, USER_ID, wireRequest.pushedEntries, wireRequest.sinceCursor)), account: ACCOUNT };
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
