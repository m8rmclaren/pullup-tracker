import type { Account, InviteResponse } from '../shared/model';
import { hashToken, newSecret } from './auth';
import { type Db, PreconditionFailed } from './db';
import { RequestError } from './errors';
import { accountOf } from './profile';
import type { Clock } from './sync';

export const DEVICE_LINK_TTL_MS = 15 * 60_000;

const LINK_GONE = 'This link has expired or was already used.';

/** A single-use link that signs another device into `userId`'s account. */
export async function createDeviceLink(db: Db, userId: string, clock: Clock): Promise<InviteResponse> {
  const code = newSecret();
  const expiresAt = clock.now() + DEVICE_LINK_TTL_MS;
  await db.putInvite(hashToken(code), { kind: 'device', userId, createdBy: userId, expiresAt });
  return { code, expiresAt };
}

/** Redeems a device link. A friend invite from before passkeys is refused: new accounts are made with a passkey. */
export async function redeemDeviceLink(db: Db, code: string, clock: Clock): Promise<{ token: string; account: Account }> {
  const codeHash = hashToken(code);
  const invite = await db.getInvite(codeHash);
  // TTL deletion lags by hours or days, so expiry is checked here, not left to DynamoDB.
  if (!invite || invite.kind !== 'device' || invite.expiresAt <= clock.now()) throw new RequestError(410, LINK_GONE);
  const user = await db.getUser(invite.userId!);
  if (!user) throw new RequestError(410, LINK_GONE);
  const token = newSecret();
  try {
    await db.redeemInvite(codeHash, hashToken(token), user.id, clock.now());
  } catch (error) {
    if (error instanceof PreconditionFailed) throw new RequestError(410, LINK_GONE);
    throw error;
  }
  return { token, account: accountOf(user) };
}
