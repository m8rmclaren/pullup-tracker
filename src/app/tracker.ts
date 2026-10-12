import { type Account, type Entry, type SyncRequest, type SyncResponse, MAX_HOLD_SECONDS, MAX_PUSHED_ENTRIES, MAX_REPS, MIN_HOLD_SECONDS, MIN_REPS, PROTOCOL_VERSION, clampAddedWeight, mergeInto, normalizeEntry } from '../shared/model';
import { type Measure, builtInExercise, builtInVariation } from '../shared/catalog';
import { type Definition, type ExerciseDefinition, MAX_PUSHED_DEFINITIONS, type VariationDefinition, definitionKeyOf, definitionKeyString, isVariationDefinition, mergeDefinitionsInto } from '../shared/definitions';
import { PROFILE_REGISTERS, type ProfilePatch } from '../shared/profile';
import { DEFAULT_TIME_ZONE } from '../shared/time';

export interface Settings {
  token: string;
  goal: number;
  /** Added weight the quick pad logs with; 0 is bodyweight. */
  padAddedWeightLbs: number;
  /** The day padAddedWeightLbs was chosen. It resets to bodyweight the next day, so a forgotten belt doesn't weight tomorrow's sets. */
  padAddedWeightDay: string;
}

/** `outdated`: the server no longer speaks this client's protocol; nothing syncs until the app reloads into a newer version. */
export type SyncStatus = 'synced' | 'syncing' | 'pending' | 'offline' | 'auth' | 'outdated' | 'unconfigured';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type Transport = (request: SyncRequest, token: string) => Promise<SyncResponse>;
export type ProfileTransport = (patch: ProfilePatch, token: string) => Promise<Account>;

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface TrackerDeps {
  storage: KeyValueStorage;
  transport: Transport;
  /** POST /api/profile. Without it, profile edits stay queued. */
  profileTransport?: ProfileTransport;
  now?: () => number;
  newId?: () => string;
  /** The device's IANA zone, used for days until the device joins an account. */
  deviceTimeZone?: string;
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
  /** Absent in state saved before definitions existed. */
  definitions?: Definition[];
  /** Keys (definitionKeyString) of definitions created or edited here and not yet acknowledged. */
  definitionOutbox?: string[];
  /** Profile edits made here and not yet acknowledged, each with its clock. */
  pendingProfile?: ProfilePatch;
}

/** What the UI needs to show an exercise, built-in or created. */
export interface ExerciseInfo {
  name: string;
  measure: Measure;
  unit?: string;
}

const STORAGE_KEY = 'pullups:v1';
export const DEFAULT_GOAL = 35;
const DEFAULT_SETTINGS: Settings = { token: '', goal: DEFAULT_GOAL, padAddedWeightLbs: 0, padAddedWeightDay: '' };
/** Taps within this window are batched into one request. */
export const SYNC_DEBOUNCE_MS = 1200;
const MAX_BACKOFF_MS = 5 * 60_000;
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * The local replica. Every mutation lands here synchronously (so the UI never waits on
 * the network), is persisted, and its id goes into the outbox; a background sync then
 * pushes the outbox and pulls whatever was written elsewhere since the last cursor.
 */
export class Tracker {
  private entries = new Map<string, Entry>();
  private outbox = new Set<string>();
  private definitions = new Map<string, Definition>();
  private definitionOutbox = new Set<string>();
  private pendingProfile: ProfilePatch = {};
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
  readonly deviceTimeZone: string;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private deps: TrackerDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? (() => crypto.randomUUID().replace(/-/g, ''));
    this.deviceTimeZone = deps.deviceTimeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
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

  /** The zone days are kept in: the account's, or this device's before it joins one. */
  timeZone(): string {
    if (this.pendingProfile.timeZone) return this.pendingProfile.timeZone;
    if (this.account) return this.account.timeZone ?? DEFAULT_TIME_ZONE;
    return this.deviceTimeZone;
  }

  /** The account's goal once one is set, else this device's own (every goal before profiles had one). */
  goal(): number {
    return this.pendingProfile.dailyGoalReps ?? this.account?.dailyGoalReps ?? this.settings.goal;
  }

  accountName(): string | undefined {
    return this.pendingProfile.name ?? this.account?.name;
  }

  /**
   * Edits the account's profile: applied here at once, queued, and sent before the next sync.
   * Signed out, only the goal applies, to this device.
   */
  updateProfile(patch: { name?: string; timeZone?: string; dailyGoalReps?: number }): void {
    if (patch.dailyGoalReps !== undefined) this.settings = { ...this.settings, goal: patch.dailyGoalReps };
    if (this.settings.token) {
      const clockAfter = (storedClock: number | undefined, pendingClock: number | undefined) => Math.max(this.now(), (storedClock ?? 0) + 1, (pendingClock ?? 0) + 1);
      const pending = { ...this.pendingProfile };
      if (patch.name !== undefined) Object.assign(pending, { name: patch.name, nameUpdatedAt: clockAfter(this.account?.nameUpdatedAt, pending.nameUpdatedAt) });
      if (patch.timeZone !== undefined) Object.assign(pending, { timeZone: patch.timeZone, zoneUpdatedAt: clockAfter(this.account?.zoneUpdatedAt, pending.zoneUpdatedAt) });
      if (patch.dailyGoalReps !== undefined) Object.assign(pending, { dailyGoalReps: patch.dailyGoalReps, goalUpdatedAt: clockAfter(this.account?.goalUpdatedAt, pending.goalUpdatedAt) });
      this.pendingProfile = pending;
      if (this.status === 'synced') this.status = 'pending';
      this.scheduleSync();
    }
    this.persist();
    this.notifyListeners();
  }

  pendingCount(): number {
    return this.outbox.size + this.definitionOutbox.size + (Object.keys(this.pendingProfile).length ? 1 : 0);
  }

  allDefinitions(): Definition[] {
    return [...this.definitions.values()];
  }

  /** A built-in or created exercise; undefined until an unknown created one arrives in a sync. */
  exercise(exerciseId: string): ExerciseInfo | undefined {
    return builtInExercise(exerciseId) ?? (this.definitions.get(exerciseId) as ExerciseDefinition | undefined);
  }

  variationName(exerciseId: string, variationId: string): string | undefined {
    return builtInVariation(variationId)?.name ?? this.definitions.get(definitionKeyString({ exerciseId, variationId }))?.name;
  }

  /** Makes an exercise usable at once, offline too; it reaches the server with the next sync. */
  createExercise(fields: { name: string; measure: Measure; unit?: string; description?: string }): ExerciseDefinition {
    const nowMs = this.now();
    const exercise: ExerciseDefinition = { id: `x-${this.newDefinitionSuffix()}`, name: fields.name, measure: fields.measure, createdAt: nowMs, updatedAt: nowMs };
    if (fields.measure === 'count') exercise.unit = fields.unit;
    if (fields.description) exercise.description = fields.description;
    this.writeDefinition(exercise);
    return exercise;
  }

  createVariation(exerciseId: string, name: string): VariationDefinition {
    const nowMs = this.now();
    const variation: VariationDefinition = { id: `v-${this.newDefinitionSuffix()}`, exerciseId, name, createdAt: nowMs, updatedAt: nowMs };
    this.writeDefinition(variation);
    return variation;
  }

  /** Renames or redescribes a definition this account created. Measure and unit never change. */
  editDefinition(definition: Definition, patch: { name?: string; description?: string }): Definition {
    const edited = { ...definition, name: patch.name ?? definition.name, updatedAt: Math.max(this.now(), definition.updatedAt + 1) };
    if (!isVariationDefinition(edited) && patch.description !== undefined) edited.description = patch.description || undefined;
    this.writeDefinition(edited);
    return edited;
  }

  /** Random lowercase base32, the alphabet created ids are checked against. */
  private newDefinitionSuffix(): string {
    return [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => BASE32_ALPHABET[byte & 31]).join('');
  }

  /** Sends queued profile edits; a field edited again while in flight stays queued. */
  private async pushProfile(token: string): Promise<void> {
    const sent = this.pendingProfile;
    if (!Object.keys(sent).length || !this.deps.profileTransport) return;
    const account = await this.deps.profileTransport(sent, token);
    if (this.settings.token !== token) return;
    this.account = account;
    const remaining: ProfilePatch = { ...this.pendingProfile };
    for (const register of PROFILE_REGISTERS) {
      if (remaining[register.clock] !== sent[register.clock]) continue;
      delete remaining[register.value];
      delete remaining[register.clock];
    }
    this.pendingProfile = remaining;
    this.persist();
  }

  private writeDefinition(definition: Definition): void {
    const keyString = definitionKeyString(definitionKeyOf(definition));
    this.definitions.delete(keyString);
    mergeDefinitionsInto(this.definitions, [definition]);
    this.definitionOutbox.add(keyString);
    this.persist();
    if (this.status === 'synced') this.status = 'pending';
    this.notifyListeners();
    this.scheduleSync();
  }

  /** A pull-up, the pad's one exercise. */
  add(reps: number, doneAt = this.now(), addedWeightLbs = 0): Entry {
    return this.log({ reps, doneAt, addedWeightLbs });
  }

  /** Logs one set of any exercise: `reps` for a counted one, `holdSeconds` for a timed one. */
  log(set: { exerciseId?: string; variationIds?: string[]; reps?: number; holdSeconds?: number; doneAt?: number; addedWeightLbs?: number }): Entry {
    const entry = { id: this.newId(), doneAt: set.doneAt ?? this.now(), updatedAt: this.now(), exerciseId: set.exerciseId, variationIds: set.variationIds, addedWeightLbs: clampAddedWeight(set.addedWeightLbs ?? 0) } as Entry;
    if (set.holdSeconds !== undefined) entry.holdSeconds = clampHoldSeconds(set.holdSeconds);
    else entry.reps = clampReps(set.reps ?? MIN_REPS);
    const normalized = normalizeEntry(entry);
    this.write(normalized);
    return normalized;
  }

  /**
   * Edits an entry, keeping every field the patch doesn't name, including ones this UI can't
   * show (exercise, variations). `reps` applies only to a counted set and `holdSeconds` only to
   * a hold. `addedWeightLbs: 0` clears the added weight.
   */
  update(id: string, patch: { reps?: number; holdSeconds?: number; doneAt?: number; addedWeightLbs?: number; deleted?: boolean }): Entry | undefined {
    const current = this.entries.get(id);
    if (!current) return undefined;
    const next: Entry = {
      ...current,
      doneAt: patch.doneAt ?? current.doneAt,
      // Strictly increase the clock so this edit beats the version it replaces even if the device clock went backwards.
      updatedAt: Math.max(this.now(), current.updatedAt + 1),
      addedWeightLbs: clampAddedWeight(patch.addedWeightLbs ?? current.addedWeightLbs ?? 0),
      deleted: patch.deleted ?? current.deleted,
    };
    if (current.reps !== undefined && patch.reps !== undefined) next.reps = clampReps(patch.reps);
    if (current.holdSeconds !== undefined && patch.holdSeconds !== undefined) next.holdSeconds = clampHoldSeconds(patch.holdSeconds);
    const normalized = normalizeEntry(next);
    this.write(normalized);
    return normalized;
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
      this.pendingProfile = {};
      this.consecutiveFailures = 0;
      this.status = this.idleStatus();
    }
    this.persist();
    this.notifyListeners();
    if (tokenChanged) this.scheduleSync(0);
  }

  /**
   * Adopts the token from a sign-up, a passkey sign-in or a device link. Sets logged before
   * signing in are pushed to the account. Switching to a different account forgets what the
   * old one had already synced, so its sets don't show (or get edited into) the new one.
   */
  signIn(token: string, account: Account): void {
    if (this.account && this.account.id !== account.id) this.forgetSyncedData();
    this.updateSettings({ token });
    this.account = account;
    this.persist();
    this.notifyListeners();
  }

  /** Unsynced work stays, to go up with the next sync; everything the server already has is dropped. */
  private forgetSyncedData(): void {
    for (const id of [...this.entries.keys()]) if (!this.outbox.has(id)) this.entries.delete(id);
    for (const keyString of [...this.definitions.keys()]) if (!this.definitionOutbox.has(keyString)) this.definitions.delete(keyString);
    this.lastSyncAt = null;
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
    if (this.status === 'outdated') return;
    if (!this.settings.token) {
      this.setStatus('unconfigured');
      return;
    }
    const pushedIds = [...this.outbox].slice(0, MAX_PUSHED_ENTRIES);
    const sentUpdatedAtById = new Map(pushedIds.map((id) => [id, this.entries.get(id)!.updatedAt]));
    const pushedDefinitionKeys = [...this.definitionOutbox].slice(0, MAX_PUSHED_DEFINITIONS);
    const sentUpdatedAtByDefinitionKey = new Map(pushedDefinitionKeys.map((keyString) => [keyString, this.definitions.get(keyString)!.updatedAt]));
    this.setStatus('syncing');
    try {
      const token = this.settings.token;
      await this.pushProfile(token);
      const response = await this.deps.transport(
        { protocolVersion: PROTOCOL_VERSION, pushedEntries: pushedIds.map((id) => this.entries.get(id)!), pushedDefinitions: pushedDefinitionKeys.map((keyString) => this.definitions.get(keyString)!), sinceCursor: this.cursor },
        token,
      );
      mergeInto(this.entries, response.entries);
      mergeDefinitionsInto(this.definitions, response.definitions ?? []);
      // The token changed mid-request: this cursor belongs to the old account.
      if (this.settings.token === token) {
        this.cursor = response.cursor;
        this.account = response.account;
      }
      // An entry edited again while the request was in flight stays queued.
      for (const [id, sentUpdatedAt] of sentUpdatedAtById) if (this.entries.get(id)?.updatedAt === sentUpdatedAt) this.outbox.delete(id);
      for (const [keyString, sentUpdatedAt] of sentUpdatedAtByDefinitionKey) if (this.definitions.get(keyString)?.updatedAt === sentUpdatedAt) this.definitionOutbox.delete(keyString);
      this.consecutiveFailures = 0;
      this.lastError = null;
      this.lastSyncAt = this.now();
      this.persist();
      this.status = this.idleStatus();
      this.notifyListeners();
      if (this.pendingCount() > 0) this.isRerunQueued = true;
    } catch (error) {
      if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
        this.lastError = error.status === 401 ? 'This device was signed out. Sign in again with your passkey or a device link.' : 'Forbidden by CloudFront — check the deploy.';
        this.setStatus('auth');
        return;
      }
      if (error instanceof HttpError && error.status === 426) {
        this.lastError = 'This version of the app is too old to sync. Reload to update; nothing logged here is lost.';
        this.setStatus('outdated');
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
    return this.pendingCount() > 0 ? 'pending' : 'synced';
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
      this.pendingProfile = persisted.pendingProfile ?? {};
      mergeDefinitionsInto(this.definitions, persisted.definitions ?? []);
      this.definitionOutbox = new Set((persisted.definitionOutbox ?? []).filter((keyString) => this.definitions.has(keyString)));
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
      definitions: [...this.definitions.values()],
      definitionOutbox: [...this.definitionOutbox],
      pendingProfile: this.pendingProfile,
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

function clampHoldSeconds(holdSeconds: number): number {
  return Math.min(MAX_HOLD_SECONDS, Math.max(MIN_HOLD_SECONDS, Math.round(holdSeconds)));
}
