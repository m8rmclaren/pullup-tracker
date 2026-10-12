import { type Definition, type DefinitionKey, definitionKeyOf, definitionKeyString, parseDefinitionKeyString } from '../shared/definitions';
import type { Challenge, Entry } from '../shared/model';
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
  /** The link the account signed up through, written once. Absent for accounts from before links, or made without one. */
  joinedVia?: { kind: LinkKind; linkCreatedBy: string };
}

export type LinkKind = 'friend' | 'challenge';

/** A shared link: whoever redeems it becomes the creator's friend, and the kind adds a landing. */
export interface Link {
  kind: LinkKind;
  createdBy: string;
  createdAt: number;
  /** Growth counters: resolves of the link, and redeems that made something new. */
  openCount: number;
  joinCount: number;
  /** Bumped on every write, so counter bumps (read, then put) can't lose one another. */
  version: number;
  challengeId?: string;
  /** A challenge link stops resolving after this; a friend link never expires. */
  expiresAt?: number;
}

/** A user's one friend link. The code is kept readable here so every device can show it; `I#<codeHash>` is the lookup. */
export interface FriendLink {
  code: string;
  codeHash: string;
}

export interface Invite {
  /** `device` is the only kind made now; a `friend` invite from before passkeys still reads, and is refused. */
  kind: 'device' | 'friend';
  /** For a device link, the account the new device joins. */
  userId?: string;
  /** Who created it: a user id, or 'admin' for scripts/invite.sh. */
  createdBy: string;
  expiresAt: number;
}

export type ChallengePurpose = 'signup' | 'login' | 'register';

/** A WebAuthn challenge waiting for its response, keyed by the challenge's digest. */
export interface PendingChallenge {
  purpose: ChallengePurpose;
  /** For signup, the id the new account will get; for register, the signed-in account. */
  userId?: string;
  /** For signup: the account's name and zone, held until the passkey exists. */
  name?: string;
  timeZone?: string;
  /** For signup: the goal this device was using, so boards can rank by it from day one. */
  dailyGoalReps?: number;
  /** For signup through a link: its digest, redeemed in the same transaction. */
  linkCodeHash?: string;
  expiresAt: number;
}

export interface Passkey {
  /** base64url, as the authenticator reports it. */
  credentialId: string;
  /** COSE public key, base64url. */
  publicKey: string;
  counter: number;
  transports?: string[];
  createdAt: number;
  label?: string;
}

/** A user's membership of a challenge, from their side. Their own link to it is kept readable, like a friend link. */
export interface Membership {
  challengeId: string;
  joinedAt: number;
  /** The challenge's last day, so active challenges list without a get per challenge. */
  toDay: string;
  linkCode: string;
  linkCodeHash: string;
}

/** What joining a challenge writes, in one transaction: both sides of the membership, the member's own link, and the adoption of the exercise. */
export interface ChallengeJoin {
  userId: string;
  membership: Membership;
  link: Link;
  /** Created exercises are adopted so the whole group logs to one id; a built-in needs nothing. */
  adoptExerciseId?: string;
  /** The person whose link it was, when they aren't friends yet. */
  befriendId?: string;
}

/** Everything a sign-up writes, in one transaction: no account exists without a passkey. */
export interface NewAccount {
  user: User;
  passkey: Passkey;
  tokenHash: string;
  /** The day the empty-account sweep first looks at this account. */
  sweepDay: string;
  /** Signing up through a link befriends its creator in the same write. */
  friendId?: string;
  /** Signing up through a challenge link joins it in the same write (its befriendId is unused: friendId covers it). */
  challengeJoin?: ChallengeJoin;
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
  /** A user's stored day totals with `fromDay <= day <= toDay`, in day order. */
  dayTotalsBetween(userId: string, fromDay: string, toDay: string): Promise<StoredDayTotal[]>;
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
  /** Stores a new session token for `userId`. */
  putToken(tokenHash: string, userId: string, createdAt: number): Promise<void>;
  putInvite(codeHash: string, invite: Invite): Promise<void>;
  getInvite(codeHash: string): Promise<Invite | null>;
  /** Atomically deletes the invite and stores the token for `userId`. Throws PreconditionFailed if the invite was already used. */
  redeemInvite(codeHash: string, tokenHash: string, userId: string, createdAt: number): Promise<void>;

  putChallenge(challengeHash: string, challenge: PendingChallenge): Promise<void>;
  /** Deletes the challenge and returns it, or null if it was never issued or already taken, so each is used once. */
  takeChallenge(challengeHash: string): Promise<PendingChallenge | null>;
  passkeysOf(userId: string): Promise<Passkey[]>;
  getPasskey(userId: string, credentialId: string): Promise<Passkey | null>;
  /** Throws PreconditionFailed if the credential is already stored for this user. */
  addPasskey(userId: string, passkey: Passkey): Promise<void>;
  /** Replaces a stored passkey, to record its sign count. */
  putPasskey(userId: string, passkey: Passkey): Promise<void>;
  /** Writes the profile, passkey, token, sweep marker and any friendship at once. Throws PreconditionFailed if the user id is taken. */
  createAccount(account: NewAccount): Promise<void>;
  /** Profiles by id; missing ones are absent. */
  getUsers(userIds: string[]): Promise<Map<string, User>>;

  getLink(codeHash: string): Promise<Link | null>;
  /** Replaces the link, conditional on its stored `version`; throws PreconditionFailed if it moved or is gone. */
  putLink(codeHash: string, link: Link, expectedVersion: number): Promise<void>;
  getFriendLink(userId: string): Promise<FriendLink | null>;
  /**
   * Makes `next` the user's friend link and stores its `link` item, deleting `previous`'s.
   * Conditional on `previous` still being the current one (null: none yet).
   */
  replaceFriendLink(userId: string, next: FriendLink, link: Link, previous: FriendLink | null): Promise<void>;

  friendIds(userId: string): Promise<string[]>;
  isFriend(userId: string, otherUserId: string): Promise<boolean>;
  /** Writes both sides of the friendship. Throws PreconditionFailed if they were already friends. */
  befriend(userId: string, friendId: string, createdAt: number): Promise<void>;
  /** Deletes both sides; a no-op for people who weren't friends. */
  unfriend(userId: string, friendId: string): Promise<void>;

  getChallenge(challengeId: string): Promise<Challenge | null>;
  getChallenges(challengeIds: string[]): Promise<Map<string, Challenge>>;
  /** Writes the challenge and joins its creator. Throws PreconditionFailed if the id is taken. */
  createChallenge(challenge: Challenge, creatorJoin: ChallengeJoin): Promise<void>;
  /** Throws PreconditionFailed if already a member, or if befriendId has become a friend meanwhile. */
  joinChallenge(join: ChallengeJoin): Promise<void>;
  /** Deletes both sides of the membership and the member's link. */
  leaveChallenge(userId: string, membership: Membership): Promise<void>;
  getMembership(userId: string, challengeId: string): Promise<Membership | null>;
  membershipsOf(userId: string): Promise<Membership[]>;
  challengeMemberIds(challengeId: string): Promise<string[]>;
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
  pendingChallenges = new Map<string, PendingChallenge>();
  /** userId → credentialId → passkey */
  passkeys = new Map<string, Map<string, Passkey>>();
  /** sweep day → user ids */
  sweepMarkers = new Map<string, Set<string>>();
  links = new Map<string, Link>();
  friendLinks = new Map<string, FriendLink>();
  /** userId → friendId → createdAt, both directions stored */
  friendships = new Map<string, Map<string, number>>();
  challenges = new Map<string, Challenge>();
  /** userId → challengeId → membership; the challenge's side is derived from it */
  memberships = new Map<string, Map<string, Membership>>();

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

  async dayTotalsBetween(userId: string, fromDay: string, toDay: string) {
    return [...this.userDayTotals(userId).values()]
      .filter((dayTotal) => dayTotal.day >= fromDay && dayTotal.day <= toDay)
      .sort((a, b) => (a.day < b.day ? -1 : 1))
      .map((dayTotal) => ({ ...dayTotal }));
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

  async putToken(tokenHash: string, userId: string) {
    this.tokens.set(tokenHash, userId);
  }

  async putInvite(codeHash: string, invite: Invite) {
    this.invites.set(codeHash, { ...invite });
  }

  async getInvite(codeHash: string) {
    const invite = this.invites.get(codeHash);
    return invite ? { ...invite } : null;
  }

  async redeemInvite(codeHash: string, tokenHash: string, userId: string) {
    if (!this.invites.has(codeHash)) throw new PreconditionFailed();
    this.invites.delete(codeHash);
    this.tokens.set(tokenHash, userId);
  }

  async putChallenge(challengeHash: string, challenge: PendingChallenge) {
    this.pendingChallenges.set(challengeHash, { ...challenge });
  }

  async takeChallenge(challengeHash: string) {
    const challenge = this.pendingChallenges.get(challengeHash);
    this.pendingChallenges.delete(challengeHash);
    return challenge ?? null;
  }

  private userPasskeys(userId: string) {
    let passkeysById = this.passkeys.get(userId);
    if (!passkeysById) this.passkeys.set(userId, (passkeysById = new Map()));
    return passkeysById;
  }

  async passkeysOf(userId: string) {
    return [...this.userPasskeys(userId).values()].map((passkey) => ({ ...passkey }));
  }

  async getPasskey(userId: string, credentialId: string) {
    const passkey = this.userPasskeys(userId).get(credentialId);
    return passkey ? { ...passkey } : null;
  }

  async addPasskey(userId: string, passkey: Passkey) {
    if (this.userPasskeys(userId).has(passkey.credentialId)) throw new PreconditionFailed();
    this.userPasskeys(userId).set(passkey.credentialId, { ...passkey });
  }

  async putPasskey(userId: string, passkey: Passkey) {
    this.userPasskeys(userId).set(passkey.credentialId, { ...passkey });
  }

  async createAccount({ user, passkey, tokenHash, sweepDay, friendId, challengeJoin }: NewAccount) {
    if (this.users.has(user.id) || this.tokens.has(tokenHash)) throw new PreconditionFailed();
    if (friendId) await this.befriend(user.id, friendId, user.createdAt);
    if (challengeJoin) await this.joinChallenge({ ...challengeJoin, befriendId: undefined });
    this.users.set(user.id, { ...user });
    this.userPasskeys(user.id).set(passkey.credentialId, { ...passkey });
    this.tokens.set(tokenHash, user.id);
    let markedUserIds = this.sweepMarkers.get(sweepDay);
    if (!markedUserIds) this.sweepMarkers.set(sweepDay, (markedUserIds = new Set()));
    markedUserIds.add(user.id);
  }

  async getUsers(userIds: string[]) {
    const usersById = new Map<string, User>();
    for (const userId of userIds) {
      const user = this.users.get(userId);
      if (user) usersById.set(userId, { ...user });
    }
    return usersById;
  }

  async getLink(codeHash: string) {
    const link = this.links.get(codeHash);
    return link ? { ...link } : null;
  }

  async putLink(codeHash: string, link: Link, expectedVersion: number) {
    if (this.links.get(codeHash)?.version !== expectedVersion) throw new PreconditionFailed();
    this.links.set(codeHash, { ...link });
  }

  async getFriendLink(userId: string) {
    const friendLink = this.friendLinks.get(userId);
    return friendLink ? { ...friendLink } : null;
  }

  async replaceFriendLink(userId: string, next: FriendLink, link: Link, previous: FriendLink | null) {
    if ((this.friendLinks.get(userId)?.codeHash ?? null) !== (previous?.codeHash ?? null)) throw new PreconditionFailed();
    if (previous) this.links.delete(previous.codeHash);
    this.links.set(next.codeHash, { ...link });
    this.friendLinks.set(userId, { ...next });
  }

  private userFriendships(userId: string) {
    let createdAtByFriendId = this.friendships.get(userId);
    if (!createdAtByFriendId) this.friendships.set(userId, (createdAtByFriendId = new Map()));
    return createdAtByFriendId;
  }

  async friendIds(userId: string) {
    return [...this.userFriendships(userId).keys()];
  }

  async isFriend(userId: string, otherUserId: string) {
    return this.userFriendships(userId).has(otherUserId);
  }

  async befriend(userId: string, friendId: string, createdAt: number) {
    if (this.userFriendships(userId).has(friendId)) throw new PreconditionFailed();
    this.userFriendships(userId).set(friendId, createdAt);
    this.userFriendships(friendId).set(userId, createdAt);
  }

  async unfriend(userId: string, friendId: string) {
    this.userFriendships(userId).delete(friendId);
    this.userFriendships(friendId).delete(userId);
  }

  async getChallenge(challengeId: string) {
    const challenge = this.challenges.get(challengeId);
    return challenge ? { ...challenge } : null;
  }

  async getChallenges(challengeIds: string[]) {
    const challengesById = new Map<string, Challenge>();
    for (const challengeId of challengeIds) {
      const challenge = this.challenges.get(challengeId);
      if (challenge) challengesById.set(challengeId, { ...challenge });
    }
    return challengesById;
  }

  private userMemberships(userId: string) {
    let membershipsById = this.memberships.get(userId);
    if (!membershipsById) this.memberships.set(userId, (membershipsById = new Map()));
    return membershipsById;
  }

  async createChallenge(challenge: Challenge, creatorJoin: ChallengeJoin) {
    if (this.challenges.has(challenge.id)) throw new PreconditionFailed();
    this.challenges.set(challenge.id, { ...challenge });
    await this.joinChallenge(creatorJoin);
  }

  async joinChallenge({ userId, membership, link, adoptExerciseId, befriendId }: ChallengeJoin) {
    if (this.userMemberships(userId).has(membership.challengeId)) throw new PreconditionFailed();
    if (befriendId) await this.befriend(userId, befriendId, membership.joinedAt);
    this.userMemberships(userId).set(membership.challengeId, { ...membership });
    this.links.set(membership.linkCodeHash, { ...link });
    if (adoptExerciseId) await this.adoptDefinition(userId, { exerciseId: adoptExerciseId }, membership.joinedAt);
  }

  async leaveChallenge(userId: string, membership: Membership) {
    this.userMemberships(userId).delete(membership.challengeId);
    this.links.delete(membership.linkCodeHash);
  }

  async getMembership(userId: string, challengeId: string) {
    const membership = this.userMemberships(userId).get(challengeId);
    return membership ? { ...membership } : null;
  }

  async membershipsOf(userId: string) {
    return [...this.userMemberships(userId).values()].map((membership) => ({ ...membership }));
  }

  async challengeMemberIds(challengeId: string) {
    return [...this.memberships].filter(([, membershipsById]) => membershipsById.has(challengeId)).map(([userId]) => userId);
  }
}
