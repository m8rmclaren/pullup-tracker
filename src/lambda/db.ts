import type { Entry, InviteKind } from '../shared/model';

/** An entry as stored: `srv` is the server time it was written, the delta-sync cursor. */
export interface StoredEntry extends Entry {
  srv: number;
}

/** One user's totals for one Denver day, recomputed from entries on every change. */
export interface DayTotal {
  day: string;
  reps: number;
  sets: number;
  best: number;
  /** Bumped on every write; guards against a stale recompute overwriting a newer one. */
  ver: number;
}

export interface User {
  id: string;
  name: string;
  createdAt: number;
}

export interface Invite {
  kind: InviteKind;
  /** For a device link, the account the new device joins. */
  uid?: string;
  /** Who created it: a user id, or 'admin' for scripts/invite.sh. */
  by: string;
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
  getEntries(uid: string, ids: string[]): Promise<Map<string, StoredEntry>>;
  /** `prevSrv` null: the entry must not exist yet. Otherwise its stored `srv` must still equal `prevSrv`. */
  putEntry(uid: string, e: StoredEntry, prevSrv: number | null): Promise<void>;
  /** Entries with `srv` strictly greater than `srv`. */
  entriesSince(uid: string, srv: number): Promise<StoredEntry[]>;
  /** Entries with `from <= ts < to`, deleted ones included. */
  entriesBetween(uid: string, from: number, to: number): Promise<StoredEntry[]>;

  getDay(uid: string, day: string): Promise<DayTotal | null>;
  /** Same precondition scheme as putEntry, on `ver`. */
  putDay(uid: string, d: DayTotal, prevVer: number | null): Promise<void>;

  getUser(uid: string): Promise<User | null>;
  userIdForToken(tokenHash: string): Promise<string | null>;
  putInvite(codeHash: string, inv: Invite): Promise<void>;
  getInvite(codeHash: string): Promise<Invite | null>;
  /**
   * Atomically deletes the invite, stores the token for `uid`, and creates `newUser` if
   * given. Throws PreconditionFailed if the invite was already used.
   */
  redeemInvite(codeHash: string, tokenHash: string, uid: string, newUser: User | null): Promise<void>;
}

/** Db semantics over plain maps, for tests and the dev server. */
export class MemoryDb implements Db {
  entries = new Map<string, Map<string, StoredEntry>>();
  days = new Map<string, Map<string, DayTotal>>();
  users = new Map<string, User>();
  tokens = new Map<string, string>();
  invites = new Map<string, Invite>();

  private userEntries(uid: string) {
    let m = this.entries.get(uid);
    if (!m) this.entries.set(uid, (m = new Map()));
    return m;
  }

  private userDays(uid: string) {
    let m = this.days.get(uid);
    if (!m) this.days.set(uid, (m = new Map()));
    return m;
  }

  async getEntries(uid: string, ids: string[]) {
    const m = this.userEntries(uid);
    const out = new Map<string, StoredEntry>();
    for (const id of ids) {
      const e = m.get(id);
      if (e) out.set(id, { ...e });
    }
    return out;
  }

  async putEntry(uid: string, e: StoredEntry, prevSrv: number | null) {
    const m = this.userEntries(uid);
    if ((m.get(e.id)?.srv ?? null) !== prevSrv) throw new PreconditionFailed();
    m.set(e.id, { ...e });
  }

  async entriesSince(uid: string, srv: number) {
    return [...this.userEntries(uid).values()].filter((e) => e.srv > srv).map((e) => ({ ...e }));
  }

  async entriesBetween(uid: string, from: number, to: number) {
    return [...this.userEntries(uid).values()].filter((e) => e.ts >= from && e.ts < to).map((e) => ({ ...e }));
  }

  async getDay(uid: string, day: string) {
    const d = this.userDays(uid).get(day);
    return d ? { ...d } : null;
  }

  async putDay(uid: string, d: DayTotal, prevVer: number | null) {
    const m = this.userDays(uid);
    if ((m.get(d.day)?.ver ?? null) !== prevVer) throw new PreconditionFailed();
    m.set(d.day, { ...d });
  }

  async getUser(uid: string) {
    const u = this.users.get(uid);
    return u ? { ...u } : null;
  }

  async userIdForToken(tokenHash: string) {
    return this.tokens.get(tokenHash) ?? null;
  }

  async putInvite(codeHash: string, inv: Invite) {
    this.invites.set(codeHash, { ...inv });
  }

  async getInvite(codeHash: string) {
    const i = this.invites.get(codeHash);
    return i ? { ...i } : null;
  }

  async redeemInvite(codeHash: string, tokenHash: string, uid: string, newUser: User | null) {
    if (!this.invites.has(codeHash) || (newUser && this.users.has(newUser.id))) throw new PreconditionFailed();
    this.invites.delete(codeHash);
    this.tokens.set(tokenHash, uid);
    if (newUser) this.users.set(newUser.id, { ...newUser });
  }
}
