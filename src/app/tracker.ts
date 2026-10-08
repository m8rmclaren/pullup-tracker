import { type Entry, type SyncRequest, type SyncResponse, MAX_PUSH, MAX_REPS, MIN_REPS, clampLbs, mergeInto } from '../shared/model';

export interface Settings {
  token: string;
  goal: number;
  /** Added weight the quick pad logs with; 0 is bodyweight. */
  padLbs: number;
  /** The Denver day padLbs was chosen. It resets to bodyweight the next day, so a forgotten belt doesn't weight tomorrow's sets. */
  padLbsDay: string;
}

export type SyncStatus = 'synced' | 'syncing' | 'pending' | 'offline' | 'auth' | 'unconfigured';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type Transport = (req: SyncRequest, token: string) => Promise<SyncResponse>;

export interface KV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface TrackerDeps {
  storage: KV;
  transport: Transport;
  now?: () => number;
  newId?: () => string;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface Persisted {
  v: 1;
  entries: Entry[];
  outbox: string[];
  etags: Record<string, string>;
  settings: Settings;
  lastSyncAt: number | null;
}

const STORAGE_KEY = 'pullups:v1';
export const DEFAULT_GOAL = 35;
const DEFAULT_SETTINGS: Settings = { token: '', goal: DEFAULT_GOAL, padLbs: 0, padLbsDay: '' };
/** Taps within this window are batched into one request. */
export const SYNC_DEBOUNCE_MS = 1200;
const MAX_BACKOFF_MS = 5 * 60_000;

/**
 * The local replica. Every mutation lands here synchronously (so the UI never waits on
 * the network), is persisted, and its id goes into the outbox; a background sync then
 * pushes the outbox and pulls whatever months changed elsewhere.
 */
export class Tracker {
  private entries = new Map<string, Entry>();
  private outbox = new Set<string>();
  private etags: Record<string, string> = {};
  settings: Settings = { ...DEFAULT_SETTINGS };
  lastSyncAt: number | null = null;
  status: SyncStatus = 'unconfigured';
  lastError: string | null = null;

  private listeners = new Set<() => void>();
  private inFlight: Promise<void> | null = null;
  private rerun = false;
  private timer: unknown = null;
  private failures = 0;

  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;

  constructor(private deps: TrackerDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? (() => crypto.randomUUID().replace(/-/g, ''));
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.load();
    this.status = this.idleStatus();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  all(): Entry[] {
    return [...this.entries.values()];
  }

  get(id: string): Entry | undefined {
    return this.entries.get(id);
  }

  pendingCount(): number {
    return this.outbox.size;
  }

  add(reps: number, ts = this.now(), lbs = 0): Entry {
    const e: Entry = { id: this.newId(), ts, reps: clampReps(reps), updatedAt: this.now() };
    if (clampLbs(lbs)) e.lbs = clampLbs(lbs);
    this.write(e);
    return e;
  }

  /** `lbs: 0` clears the added weight. */
  update(id: string, patch: { reps?: number; ts?: number; lbs?: number; deleted?: boolean }): Entry | undefined {
    const cur = this.entries.get(id);
    if (!cur) return undefined;
    const next: Entry = {
      id,
      ts: patch.ts ?? cur.ts,
      reps: clampReps(patch.reps ?? cur.reps),
      // Strictly increase the clock so this edit beats the version it replaces even if the device clock went backwards.
      updatedAt: Math.max(this.now(), cur.updatedAt + 1),
    };
    const lbs = clampLbs(patch.lbs ?? cur.lbs ?? 0);
    if (lbs) next.lbs = lbs;
    if (patch.deleted ?? cur.deleted) next.deleted = true;
    this.write(next);
    return next;
  }

  /** The pad's added weight for `day`; a choice made on an earlier day has expired. */
  padLbs(day: string): number {
    return this.settings.padLbsDay === day ? this.settings.padLbs : 0;
  }

  setPadLbs(lbs: number, day: string): void {
    this.updateSettings({ padLbs: clampLbs(lbs), padLbsDay: day });
  }

  remove(id: string): void {
    this.update(id, { deleted: true });
  }

  restore(id: string): void {
    this.update(id, { deleted: false });
  }

  updateSettings(patch: Partial<Settings>): void {
    const tokenChanged = patch.token !== undefined && patch.token !== this.settings.token;
    this.settings = { ...this.settings, ...patch };
    if (tokenChanged) {
      this.failures = 0;
      this.status = this.idleStatus();
    }
    this.persist();
    this.emit();
    if (tokenChanged) this.scheduleSync(0);
  }

  /** Re-applies every entry, e.g. from a JSON export. Older versions lose to what is already here. */
  importEntries(entries: Entry[]): number {
    const changed = mergeInto(this.entries, entries);
    for (const id of changed) this.outbox.add(id);
    this.persist();
    this.emit();
    this.scheduleSync();
    return changed.length;
  }

  scheduleSync(delay = SYNC_DEBOUNCE_MS): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.syncNow();
    }, delay);
  }

  syncNow(): Promise<void> {
    if (this.inFlight) {
      this.rerun = true;
      return this.inFlight;
    }
    this.inFlight = this.runSync().finally(() => {
      this.inFlight = null;
      if (this.rerun) {
        this.rerun = false;
        void this.syncNow();
      }
    });
    return this.inFlight;
  }

  private async runSync(): Promise<void> {
    if (!this.settings.token) {
      this.setStatus('unconfigured');
      return;
    }
    const ids = [...this.outbox].slice(0, MAX_PUSH);
    const sent = new Map(ids.map((id) => [id, this.entries.get(id)!.updatedAt]));
    this.setStatus('syncing');
    try {
      const res = await this.deps.transport({ push: ids.map((id) => this.entries.get(id)!), have: { ...this.etags } }, this.settings.token);
      for (const [month, doc] of Object.entries(res.months)) {
        mergeInto(this.entries, doc.entries);
        this.etags[month] = doc.etag;
      }
      // An entry edited again while the request was in flight stays queued.
      for (const [id, at] of sent) if (this.entries.get(id)?.updatedAt === at) this.outbox.delete(id);
      this.failures = 0;
      this.lastError = null;
      this.lastSyncAt = this.now();
      this.persist();
      this.status = this.idleStatus();
      this.emit();
      if (this.outbox.size > 0) this.rerun = true;
    } catch (err) {
      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
        this.lastError = err.status === 401 ? 'The server rejected this token.' : 'Forbidden by CloudFront — check the deploy.';
        this.setStatus('auth');
        return;
      }
      this.failures++;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.setStatus('offline');
      this.scheduleSync(backoffMs(this.failures));
    }
  }

  private write(e: Entry): void {
    this.entries.set(e.id, e);
    this.outbox.add(e.id);
    this.persist();
    if (this.status === 'synced') this.status = 'pending';
    this.emit();
    this.scheduleSync();
  }

  private idleStatus(): SyncStatus {
    if (!this.settings.token) return 'unconfigured';
    return this.outbox.size > 0 ? 'pending' : 'synced';
  }

  private setStatus(s: SyncStatus): void {
    this.status = s;
    this.emit();
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  private load(): void {
    const raw = this.deps.storage.getItem(STORAGE_KEY);
    if (!raw) return;
    try {
      const p = JSON.parse(raw) as Persisted;
      this.entries = new Map(p.entries.map((e) => [e.id, e]));
      this.outbox = new Set(p.outbox.filter((id) => this.entries.has(id)));
      this.etags = p.etags ?? {};
      this.settings = Object.assign({ ...DEFAULT_SETTINGS }, p.settings);
      this.lastSyncAt = p.lastSyncAt ?? null;
    } catch {
      // A corrupt blob is not worth crashing over; the server copy repopulates on next sync.
    }
  }

  private persist(): void {
    const p: Persisted = {
      v: 1,
      entries: [...this.entries.values()],
      outbox: [...this.outbox],
      etags: this.etags,
      settings: this.settings,
      lastSyncAt: this.lastSyncAt,
    };
    this.deps.storage.setItem(STORAGE_KEY, JSON.stringify(p));
  }
}

export function backoffMs(failures: number): number {
  return Math.min(MAX_BACKOFF_MS, 2000 * 2 ** (failures - 1));
}

function clampReps(n: number): number {
  return Math.min(MAX_REPS, Math.max(MIN_REPS, Math.round(n)));
}
