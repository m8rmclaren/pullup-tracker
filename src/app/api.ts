import { type PublicKeyCredentialCreationOptionsJSON, type PublicKeyCredentialRequestOptionsJSON, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import type { Account, ChallengeBoardResponse, Suggestion, ChallengeListItem, ChallengesResponse, FriendsResponse, LeaderboardResponse, ProfileViewResponse, InviteResponse, PasskeySummary, RedeemedLink, ResolvedLink, SessionResponse, SignupResponse, SyncRequest, SyncResponse } from '../shared/model';
import type { ProfilePatch } from '../shared/profile';
import { HttpError, type ProfileTransport, type Transport } from './tracker';

const TIMEOUT_MS = 15_000;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function post<T>(path: string, payload: unknown, token?: string): Promise<T> {
  const body = JSON.stringify(payload);
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      // CloudFront's origin access control signs requests to the Lambda URL with SigV4,
      // and for a request with a body it requires the viewer to supply the payload hash.
      'x-amz-content-sha256': await sha256Hex(body),
    };
    if (token) headers['x-pullup-token'] = token;
    const response = await fetch(path, { method: 'POST', headers, body, signal: abortController.signal, cache: 'no-store' });
    if (!response.ok) {
      let message = `HTTP ${response.status}`;
      try {
        message = ((await response.json()) as { error?: string }).error ?? message;
      } catch {}
      throw new HttpError(response.status, message);
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw new Error('Request timed out');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export const fetchTransport: Transport = (request: SyncRequest, token: string) => post<SyncResponse>('/api/sync', request, token);

export const profileTransport: ProfileTransport = (patch: ProfilePatch, token: string) => post<Account>('/api/profile', patch, token);

export const redeemDeviceLink = (code: string) => post<SessionResponse>('/api/join', { code });

export const createDeviceLink = (token: string) => post<InviteResponse>('/api/invite', { kind: 'device' }, token);

/** The link another of your devices opens to sign in. */
export const deviceLink = (code: string) => `${location.origin}/#device=${code}`;

/** Reads a device link's code out of a link (or a bare fragment); null if it isn't one. */
export function parseDeviceLink(text: string): string | null {
  return /#device=([A-Za-z0-9_-]{16,256})\s*$/.exec(text.trim())?.[1] ?? null;
}

export const isPasskeySupported = () => typeof window.PublicKeyCredential === 'function';

/** A name for this device's passkey and session, so a list of them reads as "iPhone", "Mac". */
function deviceLabel(): string {
  const userAgent = navigator.userAgent;
  for (const [pattern, label] of [[/iPhone/, 'iPhone'], [/iPad/, 'iPad'], [/Android/, 'Android'], [/Macintosh/, 'Mac'], [/Windows/, 'Windows'], [/CrOS/, 'Chromebook'], [/Linux/, 'Linux']] as const) {
    if (pattern.test(userAgent)) return label;
  }
  return 'Browser';
}

/** Makes an account: the server holds the name (and any link) while this device creates a passkey for it. */
export async function signUpWithPasskey(fields: { name: string; timeZone: string; dailyGoalReps: number; linkCode?: string }): Promise<SignupResponse> {
  const optionsJSON = await post<PublicKeyCredentialCreationOptionsJSON>('/api/signup/options', fields);
  const credential = await startRegistration({ optionsJSON });
  return post<SignupResponse>('/api/signup', { credential, label: deviceLabel() });
}

/** Signs this device in with whichever passkey it has for this domain; there's no username to type. */
export async function signInWithPasskey(): Promise<SessionResponse> {
  const optionsJSON = await post<PublicKeyCredentialRequestOptionsJSON>('/api/passkey/login/options', {});
  const credential = await startAuthentication({ optionsJSON });
  return post<SessionResponse>('/api/passkey/login', { credential, label: deviceLabel() });
}

export async function addPasskey(token: string): Promise<{ passkeys: PasskeySummary[] }> {
  const optionsJSON = await post<PublicKeyCredentialCreationOptionsJSON>('/api/passkey/register/options', {}, token);
  const credential = await startRegistration({ optionsJSON });
  return post<{ passkeys: PasskeySummary[] }>('/api/passkey/register', { credential, label: deviceLabel() }, token);
}

export const listPasskeys = (token: string) => post<{ passkeys: PasskeySummary[] }>('/api/passkey/list', {}, token);

/** What to tell someone when a passkey step fails; a dismissed Face ID prompt isn't an error worth a paragraph. */
export function passkeyErrorMessage(error: unknown): string {
  if (error instanceof Error && error.name === 'NotAllowedError') return 'Cancelled.';
  if (error instanceof Error && error.name === 'InvalidStateError') return 'This device already has a passkey for this account.';
  return error instanceof Error ? error.message : String(error);
}

export const fetchFriends = (token: string) => post<FriendsResponse>('/api/friends', {}, token);

export const removeFriend = (friendId: string, token: string) => post<object>('/api/friends/remove', { friendId }, token);

export const rotateFriendLink = (token: string) => post<{ friendLink: string }>('/api/friends/rotate-link', {}, token);

export const resolveLink = (code: string) => post<ResolvedLink>('/api/links/resolve', { code });

export const redeemLink = (code: string, token: string) => post<RedeemedLink>('/api/links/redeem', { code }, token);

/** A friend or challenge link. The code rides in the fragment, so it never reaches CloudFront's logs. */
export const joinLink = (code: string) => `${location.origin}/#join=${code}`;

export function parseJoinLink(text: string): string | null {
  return /#join=([A-Za-z0-9_-]{16,256})\s*$/.exec(text.trim())?.[1] ?? null;
}

/** The share sheet where there is one, else the clipboard. Returns what to tell the user, if anything. */
export async function shareUrl(url: string): Promise<string | null> {
  try {
    if (navigator.share) {
      await navigator.share({ url });
      return null;
    }
    await navigator.clipboard.writeText(url);
    return 'Copied.';
  } catch {
    return null;
  }
}

export const fetchLeaderboard = (window: { fromDay: string; toDay: string }, token: string) => post<LeaderboardResponse>('/api/leaderboard', window, token);

export const fetchProfile = (userId: string, token: string) => post<ProfileViewResponse>('/api/profile/view', { userId }, token);

export const fetchChallenges = (token: string) => post<ChallengesResponse>('/api/challenges/list', {}, token);

export const createChallenge = (fields: { exerciseId: string; fromDay: string; toDay: string; target?: number }, token: string) => post<ChallengeListItem>('/api/challenges/create', fields, token);

export const fetchChallengeBoard = (challengeId: string, token: string) => post<ChallengeBoardResponse>('/api/challenges/board', { challengeId }, token);

export const leaveChallenge = (challengeId: string, token: string) => post<object>('/api/challenges/leave', { challengeId }, token);

export const fetchChallengeLink = (challengeId: string, token: string) => post<{ link: string }>('/api/challenges/link', { challengeId }, token);

export const sendFriendRequest = (userId: string, challengeId: string, token: string) => post<{ status: 'requested' | 'friends' }>('/api/friends/request', { userId, challengeId }, token);

export const respondToFriendRequest = (userId: string, accept: boolean, token: string) => post<object>('/api/friends/respond', { userId, accept }, token);

export const cancelFriendRequest = (userId: string, token: string) => post<object>('/api/friends/cancel', { userId }, token);

export const fetchSuggestions = (token: string) => post<{ suggestions: Suggestion[] }>('/api/friends/suggestions', {}, token);
