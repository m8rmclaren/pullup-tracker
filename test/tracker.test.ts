import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/lambda/store';
import { handleSync } from '../src/lambda/sync';
import type { SyncRequest } from '../src/shared/model';
import { HttpError, type KV, Tracker, type Transport, backoffMs } from '../src/app/tracker';

class MemKV implements KV {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
}

/** Manual timers so tests decide when the debounced sync fires. */
class Clock {
  t = Date.parse('2026-10-08T18:00:00Z');
  timers: { fn: () => void; at: number }[] = [];
  now = () => this.t;
  setTimer = (fn: () => void, ms: number) => {
    const h = { fn, at: this.t + ms };
    this.timers.push(h);
    return h;
  };
  clearTimer = (h: unknown) => {
    this.timers = this.timers.filter((x) => x !== h);
  };
  pending() {
    return this.timers.length;
  }
}

let ids = 0;
function makeTracker(transport: Transport, kv = new MemKV(), clock = new Clock()) {
  const t = new Tracker({ storage: kv, transport, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, newId: () => `t${++ids}` });
  t.updateSettings({ token: 'tok' });
  return { t, kv, clock };
}

const serverTransport = (store: MemoryStore): Transport => (req) => handleSync(store, JSON.parse(JSON.stringify(req)));

describe('Tracker', () => {
  let store: MemoryStore;
  beforeEach(() => {
    store = new MemoryStore();
  });

  it('records a tap locally and persists it before any network', () => {
    const { t, kv } = makeTracker(async () => {
      throw new Error('offline');
    });
    t.add(6);
    expect(t.all()).toHaveLength(1);
    expect(t.pendingCount()).toBe(1);
    const reloaded = new Tracker({ storage: kv, transport: async () => ({ months: {} }) });
    expect(reloaded.all()[0]!.reps).toBe(6);
    expect(reloaded.pendingCount()).toBe(1);
  });

  it('batches rapid taps into a single debounced sync', async () => {
    const calls: SyncRequest[] = [];
    const { t, clock } = makeTracker(async (req) => {
      calls.push(req);
      return handleSync(store, req);
    });
    clock.timers = [];
    t.add(5);
    t.add(5);
    t.add(4);
    expect(clock.pending()).toBe(1);
    await t.syncNow();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.push).toHaveLength(3);
    expect(t.pendingCount()).toBe(0);
    expect(t.status).toBe('synced');
  });

  it('keeps an entry queued if it was edited while its push was in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { t } = makeTracker(async (req) => {
      await gate;
      return handleSync(store, req);
    });
    const e = t.add(5);
    const p = t.syncNow();
    t.update(e.id, { reps: 8 });
    release();
    await p;
    expect(t.get(e.id)!.reps).toBe(8);
    expect(t.pendingCount()).toBe(1);
    await t.syncNow();
    expect(t.pendingCount()).toBe(0);
    const server = await handleSync(store, { push: [], have: {} });
    expect(server.months['2026-10']!.entries[0]!.reps).toBe(8);
  });

  it('two devices converge, including an edit and a delete made offline', async () => {
    const A = makeTracker(serverTransport(store));
    const B = makeTracker(serverTransport(store));
    const s1 = A.t.add(5);
    const s2 = B.t.add(7);
    await A.t.syncNow();
    await B.t.syncNow();
    await A.t.syncNow();
    expect(A.t.all().length).toBe(2);

    A.clock.t += 1000;
    B.clock.t += 2000;
    A.t.update(s2.id, { reps: 6 }); // A edits B's set…
    B.t.remove(s2.id); // …while B deletes it, later
    B.t.update(s1.id, { reps: 4 });
    await A.t.syncNow();
    await B.t.syncNow();
    await A.t.syncNow();

    const view = (t: Tracker) => t.all().sort((a, b) => (a.id < b.id ? -1 : 1));
    expect(view(A.t)).toEqual(view(B.t));
    expect(A.t.get(s2.id)!.deleted).toBe(true);
    expect(A.t.get(s1.id)!.reps).toBe(4);
  });

  it('a fresh device with cleared storage pulls the full history', async () => {
    const A = makeTracker(serverTransport(store));
    A.t.add(5);
    A.t.add(6, Date.parse('2026-09-15T18:00:00Z'));
    await A.t.syncNow();
    const fresh = makeTracker(serverTransport(store));
    await fresh.t.syncNow();
    expect(fresh.t.all().map((e) => e.reps).sort()).toEqual([5, 6]);
  });

  it('an undo before the first sync still reaches the server as a tombstone', async () => {
    const { t } = makeTracker(serverTransport(store));
    const e = t.add(5);
    t.remove(e.id);
    await t.syncNow();
    const server = await handleSync(store, { push: [], have: {} });
    expect(server.months['2026-10']!.entries[0]!.deleted).toBe(true);
  });

  it('backs off on network failure and stops on a rejected token', async () => {
    let mode: 'down' | 'auth' = 'down';
    const { t, clock } = makeTracker(async () => {
      throw mode === 'down' ? new TypeError('Failed to fetch') : new HttpError(401, 'bad token');
    });
    t.add(5);
    clock.timers = [];
    await t.syncNow();
    expect(t.status).toBe('offline');
    expect(clock.timers[0]!.at - clock.t).toBe(backoffMs(1));
    await t.syncNow();
    expect(clock.timers.at(-1)!.at - clock.t).toBe(backoffMs(2));
    expect(t.pendingCount()).toBe(1);

    mode = 'auth';
    clock.timers = [];
    await t.syncNow();
    expect(t.status).toBe('auth');
    expect(clock.pending()).toBe(0);
  });

  it('never lets a device clock that went backwards lose an edit', () => {
    const { t, clock } = makeTracker(async () => ({ months: {} }));
    const e = t.add(5);
    clock.t -= 60_000;
    const edited = t.update(e.id, { reps: 7 })!;
    expect(edited.updatedAt).toBeGreaterThan(e.updatedAt);
  });

  it('logs, edits and clears added weight, and syncs it', async () => {
    const { t } = makeTracker(serverTransport(store));
    const e = t.add(5, undefined, 25);
    expect(e.lbs).toBe(25);
    expect(t.update(e.id, { reps: 4 })!.lbs).toBe(25);
    await t.syncNow();
    const fresh = makeTracker(serverTransport(store)).t;
    await fresh.syncNow();
    expect(fresh.get(e.id)!.lbs).toBe(25);
    expect('lbs' in t.update(e.id, { lbs: 0 })!).toBe(false);
    expect('lbs' in t.add(5)).toBe(false);
  });

  it('the pad weight expires at the end of the day it was chosen', () => {
    const { t } = makeTracker(async () => ({ months: {} }));
    t.setPadLbs(45, '2026-10-08');
    expect(t.padLbs('2026-10-08')).toBe(45);
    expect(t.padLbs('2026-10-09')).toBe(0);
  });
});

describe('backoffMs', () => {
  it('doubles from 2s and caps at 5 minutes', () => {
    expect([1, 2, 3].map(backoffMs)).toEqual([2000, 4000, 8000]);
    expect(backoffMs(20)).toBe(300_000);
  });
});
