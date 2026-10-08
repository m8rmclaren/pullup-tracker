import { type Account, type InviteKind, type InviteResponse, cleanName } from '../shared/model';
import { hashToken, newSecret, newUserId } from './auth';
import { type Db, PreconditionFailed } from './db';
import type { Clock } from './sync';

export const FRIEND_INVITE_TTL_MS = 7 * 86_400_000;
export const DEVICE_LINK_TTL_MS = 15 * 60_000;

/** A friend invite creates a new account; a device link signs another device into `createdBy`'s. Both are single-use. */
export async function createInvite(db: Db, createdBy: string, kind: InviteKind, clock: Clock): Promise<InviteResponse> {
  const code = newSecret();
  const expiresAt = clock.now() + (kind === 'friend' ? FRIEND_INVITE_TTL_MS : DEVICE_LINK_TTL_MS);
  await db.putInvite(hashToken(code), kind === 'device' ? { kind, userId: createdBy, createdBy, expiresAt } : { kind, createdBy, expiresAt });
  return { code, expiresAt };
}

export type RedeemResult = { ok: true; token: string; account: Account } | { ok: false; status: number; error: string };

const INVITE_GONE: RedeemResult = { ok: false, status: 410, error: 'This link has expired or was already used.' };

export async function redeemInvite(db: Db, code: string, rawName: unknown, clock: Clock): Promise<RedeemResult> {
  const codeHash = hashToken(code);
  const invite = await db.getInvite(codeHash);
  // TTL deletion lags by hours or days, so expiry is checked here, not left to DynamoDB.
  if (!invite || invite.expiresAt <= clock.now()) return INVITE_GONE;

  const token = newSecret();
  let account: Account;
  try {
    if (invite.kind === 'device') {
      const user = await db.getUser(invite.userId!);
      if (!user) return INVITE_GONE;
      await db.redeemInvite(codeHash, hashToken(token), user.id, null);
      account = { id: user.id, name: user.name };
    } else {
      const name = cleanName(rawName);
      if (!name) return { ok: false, status: 400, error: 'Pick a name of 1 to 24 characters.' };
      const user = { id: newUserId(), name, createdAt: clock.now() };
      await db.redeemInvite(codeHash, hashToken(token), user.id, user);
      account = { id: user.id, name };
    }
  } catch (error) {
    if (error instanceof PreconditionFailed) return INVITE_GONE;
    throw error;
  }
  return { ok: true, token, account };
}
