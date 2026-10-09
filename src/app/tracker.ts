import { type Account, type Entry, type SyncRequest, type SyncResponse, MAX_PUSHED_ENTRIES, MAX_REPS, MIN_REPS, clampAddedWeight, mergeInto } from '../shared/model';

export interface Settings {
  token: string;
  goal: number;
  /** Added weight the quick pad logs with; 0 is bodyweight. */
  padAddedWeightLbs: number;
  /** The Denver day padAddedWeightLbs was chosen. It resets to bodyweight the next day, so a forgotten belt doesn't weight tomorrow's sets. */
  padAddedWeightDay: string;
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

export type Transport = (request: SyncRequest, token: string) => Promise<SyncResponse>;

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface TrackerDeps {
  storage: KeyValueStorage;
  transport: Transport;
  now?: () => number;
  newId?: () => string;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface PersistedState {
  version: 1;
  entries: Entry[];
  outbox: string[];
  /** Server cursor from the last sync; 0 means pull everything. */
  cursor: number;
  account: Account | null;
  settings: Settings;
  lastSyncAt: number | null;
}

const STORAGE_KEY = 'pullups:v1';
export const DEFAULT_GOAL = 35;
const DEFAULT_SETTINGS: Settings = { token: '', goal: DEFAULT_GOAL, padAddedWeightLbs: 0, padAddedWeightDay: '' };
/** Taps within this window are batched into one request. */
export const SYNC_DEBOUNCE_MS = 1200;
const MAX_BACKOFF_MS = 5 * 60_000;

/**
 * The local replica. Every mutation lands here synchronously (so the UI never waits on
 * the network), is persisted, and its id goes into the outbox; a background sync then
 * pushes the outbox and pulls whatever was written elsewhere since the last cursor.
 */
export class Tracker {
  private entries = new Map<string, Entry>();
  private outbox = new Set<string>();
  private cursor = 0;
  /** Who this device is signed in as, from the last sync or join. */
  account: Account | null = null;
  settings: Settings = { ...DEFAULT_SETTINGS };
  lastSyncAt: number | null = null;
  status: SyncStatus = 'unconfigured';
  lastError: string | null = null;

  private listeners = new Set<() => void>();
  private inFlightSync: Promise<void> | null = null;
  private isRerunQueued = false;
  private syncTimer: unknown = null;
  private consecutiveFailures = 0;

  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private deps: TrackerDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? (() => crypto.randomUUID().replace(/-/g, ''));
    this.setTimer = deps.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.load();
    this.status = this.idleStatus();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  allEntries(): Entry[] {
    return [...this.entries.values()];
  }

  getEntry(id: string): Entry | undefined {
    return this.entries.get(id);
  }

  pendingCount(): number {
    return this.outbox.size;
  }

  add(reps: number, doneAt = this.now(), addedWeightLbs = 0): Entry {
    const entry: Entry = { id: this.newId(), doneAt, reps: clampReps(reps), updatedAt: this.now() };
    if (clampAddedWeight(addedWeightLbs)) entry.addedWeightLbs = clampAddedWeight(addedWeightLbs);
    this.write(entry);
    return entry;
  }

  /** `addedWeightLbs: 0` clears the added weight. */
  update(id: string, patch: { reps?: number; doneAt?: number; addedWeightLbs?: number; deleted?: boolean }): Entry | undefined {
    const current = this.entries.get(id);
    if (!current) return undefined;
    const next: Entry = {
      id,
      doneAt: patch.doneAt ?? current.doneAt,
      reps: clampReps(patch.reps ?? current.reps),
      // Strictly increase the clock so this edit beats the version it replaces even if the device clock went backwards.
      updatedAt: Math.max(this.now(), current.updatedAt + 1),
    };
    const addedWeightLbs = clampAddedWeight(patch.addedWeightLbs ?? current.addedWeightLbs ?? 0);
    if (addedWeightLbs) next.addedWeightLbs = addedWeightLbs;
    if (patch.deleted ?? current.deleted) next.deleted = true;
    this.write(next);
    return next;
  }

  /** The pad's added weight for `day`; a choice made on an earlier day has expired. */
  padAddedWeightLbs(day: string): number {
    return this.settings.padAddedWeightDay === day ? this.settings.padAddedWeightLbs : 0;
  }

  setPadAddedWeight(addedWeightLbs: number, day: string): void {
    this.updateSettings({ padAddedWeightLbs: clampAddedWeight(addedWeightLbs), padAddedWeightDay: day });
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
      // A different token may be a different account; pull its whole history.
      this.cursor = 0;
      this.account = null;
      this.consecutiveFailures = 0;
      this.status = this.idleStatus();
    }
    this.persist();
    this.notifyListeners();
    if (tokenChanged) this.scheduleSync(0);
  }

  /** Adopts the token from a redeemed invite. Sets logged before joining are pushed to the new account. */
  signIn(token: string, account: Account): void {
    this.updateSettings({ token });
    this.account = account;
    this.persist();
    this.notifyListeners();
  }

  /** Re-applies every entry, e.g. from a JSON export. Older versions lose to what is already here. */
  importEntries(entries: Entry[]): number {
    const changedIds = mergeInto(this.entries, entries);
    for (const id of changedIds) this.outbox.add(id);
    this.persist();
    this.notifyListeners();
    this.scheduleSync();
    return changedIds.length;
  }

  scheduleSync(delayMs = SYNC_DEBOUNCE_MS): void {
    if (this.syncTimer !== null) this.clearTimer(this.syncTimer);
    this.syncTimer = this.setTimer(() => {
      this.syncTimer = null;
      void this.syncNow();
    }, delayMs);
  }

  syncNow(): Promise<void> {
    if (this.inFlightSync) {
      this.isRerunQueued = true;
      return this.inFlightSync;
    }
    this.inFlightSync = this.runSync().finally(() => {
      this.inFlightSync = null;
      if (this.isRerunQueued) {
        this.isRerunQueued = false;
        void this.syncNow();
      }
    });
    return this.inFlightSync;
  }

  private async runSync(): Promise<void> {
    if (!this.settings.token) {
      this.setStatus('unconfigured');
      return;
    }
    const pushedIds = [...this.outbox].slice(0, MAX_PUSHED_ENTRIES);
    const sentUpdatedAtById = new Map(pushedIds.map((id) => [id, this.entries.get(id)!.updatedAt]));
    this.setStatus('syncing');
    try {
      const token = this.settings.token;
      const response = await this.deps.transport({ pushedEntries: pushedIds.map((id) => this.entries.get(id)!), sinceCursor: this.cursor }, token);
      mergeInto(this.entries, response.entries);
      // The token changed mid-request: this cursor belongs to the old account.
      if (this.settings.token === token) {
        this.cursor = response.cursor;
        this.account = response.account;
      }
      // An entry edited again while the request was in flight stays queued.
      for (const [id, sentUpdatedAt] of sentUpdatedAtById) if (this.entries.get(id)?.updatedAt === sentUpdatedAt) this.outbox.delete(id);
      this.consecutiveFailures = 0;
      this.lastError = null;
      this.lastSyncAt = this.now();
      this.persist();
      this.status = this.idleStatus();
      this.notifyListeners();
      if (this.outbox.size > 0) this.isRerunQueued = true;
    } catch (error) {
      if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
        this.lastError = error.status === 401 ? 'This device was signed out. Open a new device link to sign back in.' : 'Forbidden by CloudFront — check the deploy.';
        this.setStatus('auth');
        return;
      }
      this.consecutiveFailures++;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.setStatus('offline');
      this.scheduleSync(backoffMs(this.consecutiveFailures));
    }
  }

  private write(entry: Entry): void {
    this.entries.set(entry.id, entry);
    this.outbox.add(entry.id);
    this.persist();
    if (this.status === 'synced') this.status = 'pending';
    this.notifyListeners();
    this.scheduleSync();
  }

  private idleStatus(): SyncStatus {
    if (!this.settings.token) return 'unconfigured';
    return this.outbox.size > 0 ? 'pending' : 'synced';
  }

  private setStatus(status: SyncStatus): void {
    this.status = status;
    this.notifyListeners();
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) listener();
  }

  private load(): void {
    const serialized = this.deps.storage.getItem(STORAGE_KEY);
    if (!serialized) return;
    try {
      const persisted = JSON.parse(serialized) as PersistedState;
      this.entries = new Map(persisted.entries.map((entry) => [entry.id, entry]));
      this.outbox = new Set(persisted.outbox.filter((id) => this.entries.has(id)));
      this.cursor = persisted.cursor ?? 0;
      this.account = persisted.account ?? null;
      this.settings = Object.assign({ ...DEFAULT_SETTINGS }, persisted.settings);
      this.lastSyncAt = persisted.lastSyncAt ?? null;
    } catch {
      // A corrupt blob is not worth crashing over; the server copy repopulates on next sync.
    }
  }

  private persist(): void {
    const state: PersistedState = {
      version: 1,
      entries: [...this.entries.values()],
      outbox: [...this.outbox],
      cursor: this.cursor,
      account: this.account,
      settings: this.settings,
      lastSyncAt: this.lastSyncAt,
    };
    this.deps.storage.setItem(STORAGE_KEY, JSON.stringify(state));
  }
}

export function backoffMs(consecutiveFailures: number): number {
  return Math.min(MAX_BACKOFF_MS, 2000 * 2 ** (consecutiveFailures - 1));
}

function clampReps(reps: number): number {
  return Math.min(MAX_REPS, Math.max(MIN_REPS, Math.round(reps)));
}
