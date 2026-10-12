import { type Definition, type DefinitionKey, definitionKeyOf, definitionKeyString, parseDefinitionKeyString } from '../shared/definitions';
import type { Entry, InviteKind } from '../shared/model';
import type { ProfileFields } from '../shared/profile';
import type { DayTotalRecord } from '../shared/stats';

/** An entry as stored: `serverWrittenAt` is the server time it was written, the delta-sync cursor. */
export interface StoredEntry extends Entry {
  serverWrittenAt: number;
}

/**
 * One user's totals for one day in their zone, recomputed from entries on every change.
 * `holdSeconds` and `byExercise` are absent on a total written before v2; read those with exerciseDayTotals.
 */
export interface StoredDayTotal extends Omit<DayTotalRecord, 'holdSeconds' | 'byExercise'>, Partial<Pick<DayTotalRecord, 'holdSeconds' | 'byExercise'>> {
  /** Bumped on every write; guards against a stale recompute overwriting a newer one. */
  version: number;
}

/** A created exercise or variation as stored: `version` is bumped on every write and guards against a lost update. */
export type StoredDefinition = Definition & { version: number };

export interface User extends ProfileFields {
  id: string;
  createdAt: number;
  /** Bumped on every profile write. Absent on a profile never edited since sign-up. */
  version?: number;
}

export interface Invite {
  kind: InviteKind;
  /** For a device link, the account the new device joins. */
  userId?: string;
  /** Who created it: a user id, or 'admin' for scripts/invite.sh. */
  createdBy: string;
  expiresAt: number;
}

/** Thrown when a conditional write loses a race; the caller re-reads and retries. */
export class PreconditionFailed extends Error {
  constructor() {
    super('precondition failed');
  }
}

/**
 * Storage the API needs, kept narrow so the merge and concurrency logic runs against
 * memory in tests and dev. Every read is strongly consistent.
 */
export interface Db {
  getEntries(userId: string, ids: string[]): Promise<Map<string, StoredEntry>>;
  /** `expectedServerWrittenAt` null: the entry must not exist yet. Otherwise its stored `serverWrittenAt` must still equal `expectedServerWrittenAt`. */
  putEntry(userId: string, entry: StoredEntry, expectedServerWrittenAt: number | null): Promise<void>;
  /** Entries with `serverWrittenAt` strictly greater than `serverWrittenAt`. */
  entriesWrittenAfter(userId: string, serverWrittenAt: number): Promise<StoredEntry[]>;
  /** Entries with `fromMs <= doneAt < toMs`, deleted ones included. */
  entriesDoneBetween(userId: string, fromMs: number, toMs: number): Promise<StoredEntry[]>;

  getDayTotal(userId: string, day: string): Promise<StoredDayTotal | null>;
  /** Same precondition scheme as putEntry, on `version`. */
  putDayTotal(userId: string, dayTotal: StoredDayTotal, expectedVersion: number | null): Promise<void>;

  /** Keyed by definitionKeyString; missing keys are absent. */
  getDefinitions(keys: DefinitionKey[]): Promise<Map<string, StoredDefinition>>;
  /** Atomically creates the definition and adopts it for `userId`. Throws PreconditionFailed if it already exists. */
  createDefinition(definition: StoredDefinition, userId: string, adoptedAt: number): Promise<void>;
  /** The stored `version` must still equal `expectedVersion`. */
  putDefinition(definition: StoredDefinition, expectedVersion: number): Promise<void>;
  /** The definitions a user has created or logged to, which every sync returns. */
  adoptedDefinitionKeys(userId: string): Promise<DefinitionKey[]>;
  adoptDefinition(userId: string, key: DefinitionKey, adoptedAt: number): Promise<void>;

  getUser(userId: string): Promise<User | null>;
  /** Replaces an existing profile. `expectedVersion` null: the stored profile must have no version yet. */
  putProfile(user: User, expectedVersion: number | null): Promise<void>;
  userIdForToken(tokenHash: string): Promise<string | null>;
  putInvite(codeHash: string, invite: Invite): Promise<void>;
  getInvite(codeHash: string): Promise<Invite | null>;
  /**
   * Atomically deletes the invite, stores the token for `userId`, and creates `newUser` if
   * given. Throws PreconditionFailed if the invite was already used.
   */
  redeemInvite(codeHash: string, tokenHash: string, userId: string, newUser: User | null): Promise<void>;
}

/** Db semantics over plain maps, for tests and the dev server. */
export class MemoryDb implements Db {
  entries = new Map<string, Map<string, StoredEntry>>();
  dayTotals = new Map<string, Map<string, StoredDayTotal>>();
  users = new Map<string, User>();
  tokens = new Map<string, string>();
  invites = new Map<string, Invite>();
  definitions = new Map<string, StoredDefinition>();
  /** userId → definitionKeyString → adoptedAt */
  adoptions = new Map<string, Map<string, number>>();

  private userEntries(userId: string) {
    let entriesById = this.entries.get(userId);
    if (!entriesById) this.entries.set(userId, (entriesById = new Map()));
    return entriesById;
  }

  private userDayTotals(userId: string) {
    let dayTotalsByDay = this.dayTotals.get(userId);
    if (!dayTotalsByDay) this.dayTotals.set(userId, (dayTotalsByDay = new Map()));
    return dayTotalsByDay;
  }

  async getEntries(userId: string, ids: string[]) {
    const entriesById = this.userEntries(userId);
    const foundEntries = new Map<string, StoredEntry>();
    for (const id of ids) {
      const entry = entriesById.get(id);
      if (entry) foundEntries.set(id, { ...entry });
    }
    return foundEntries;
  }

  async putEntry(userId: string, entry: StoredEntry, expectedServerWrittenAt: number | null) {
    const entriesById = this.userEntries(userId);
    if ((entriesById.get(entry.id)?.serverWrittenAt ?? null) !== expectedServerWrittenAt) throw new PreconditionFailed();
    entriesById.set(entry.id, { ...entry });
  }

  async entriesWrittenAfter(userId: string, serverWrittenAt: number) {
    return [...this.userEntries(userId).values()].filter((entry) => entry.serverWrittenAt > serverWrittenAt).map((entry) => ({ ...entry }));
  }

  async entriesDoneBetween(userId: string, fromMs: number, toMs: number) {
    return [...this.userEntries(userId).values()].filter((entry) => entry.doneAt >= fromMs && entry.doneAt < toMs).map((entry) => ({ ...entry }));
  }

  async getDayTotal(userId: string, day: string) {
    const dayTotal = this.userDayTotals(userId).get(day);
    return dayTotal ? { ...dayTotal } : null;
  }

  async putDayTotal(userId: string, dayTotal: StoredDayTotal, expectedVersion: number | null) {
    const dayTotalsByDay = this.userDayTotals(userId);
    if ((dayTotalsByDay.get(dayTotal.day)?.version ?? null) !== expectedVersion) throw new PreconditionFailed();
    dayTotalsByDay.set(dayTotal.day, { ...dayTotal });
  }

  async getDefinitions(keys: DefinitionKey[]) {
    const definitionsByKey = new Map<string, StoredDefinition>();
    for (const key of keys) {
      const definition = this.definitions.get(definitionKeyString(key));
      if (definition) definitionsByKey.set(definitionKeyString(key), { ...definition });
    }
    return definitionsByKey;
  }

  async createDefinition(definition: StoredDefinition, userId: string, adoptedAt: number) {
    const keyString = definitionKeyString(definitionKeyOf(definition));
    if (this.definitions.has(keyString)) throw new PreconditionFailed();
    this.definitions.set(keyString, { ...definition });
    await this.adoptDefinition(userId, definitionKeyOf(definition), adoptedAt);
  }

  async putDefinition(definition: StoredDefinition, expectedVersion: number) {
    const keyString = definitionKeyString(definitionKeyOf(definition));
    if (this.definitions.get(keyString)?.version !== expectedVersion) throw new PreconditionFailed();
    this.definitions.set(keyString, { ...definition });
  }

  async adoptedDefinitionKeys(userId: string) {
    return [...(this.adoptions.get(userId)?.keys() ?? [])].map(parseDefinitionKeyString);
  }

  async adoptDefinition(userId: string, key: DefinitionKey, adoptedAt: number) {
    let adoptedAtByKey = this.adoptions.get(userId);
    if (!adoptedAtByKey) this.adoptions.set(userId, (adoptedAtByKey = new Map()));
    adoptedAtByKey.set(definitionKeyString(key), adoptedAt);
  }

  async getUser(userId: string) {
    const user = this.users.get(userId);
    return user ? { ...user } : null;
  }

  async putProfile(user: User, expectedVersion: number | null) {
    const stored = this.users.get(user.id);
    if (!stored || (stored.version ?? null) !== expectedVersion) throw new PreconditionFailed();
    this.users.set(user.id, { ...user });
  }

  async userIdForToken(tokenHash: string) {
    return this.tokens.get(tokenHash) ?? null;
  }

  async putInvite(codeHash: string, invite: Invite) {
    this.invites.set(codeHash, { ...invite });
  }

  async getInvite(codeHash: string) {
    const invite = this.invites.get(codeHash);
    return invite ? { ...invite } : null;
  }

  async redeemInvite(codeHash: string, tokenHash: string, userId: string, newUser: User | null) {
    if (!this.invites.has(codeHash) || (newUser && this.users.has(newUser.id))) throw new PreconditionFailed();
    this.invites.delete(codeHash);
    this.tokens.set(tokenHash, userId);
    if (newUser) this.users.set(newUser.id, { ...newUser });
  }
}
