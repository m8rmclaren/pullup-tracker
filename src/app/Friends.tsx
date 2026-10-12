import { useEffect, useMemo, useState } from 'preact/hooks';
import { encode } from 'uqr';
import { MAX_NAME_LENGTH, type Friend, type ResolvedLink, cleanName } from '../shared/model';
import { fetchFriends, isPasskeySupported, joinLink, passkeyErrorMessage, redeemLink, removeFriend, resolveLink, rotateFriendLink, shareUrl, signInWithPasskey, signUpWithPasskey } from './api';
import { FriendsBoard } from './Board';
import { Sheet } from './sheets';
import type { Tracker } from './tracker';

/** A QR code drawn as one SVG path, so it scales crisply and needs no image. */
export function QrCode({ text, label }: { text: string; label: string }) {
  const path = useMemo(() => {
    const { data } = encode(text, { ecc: 'M', border: 2 });
    let commands = '';
    data.forEach((row, y) => row.forEach((isDark, x) => isDark && (commands += `M${x} ${y}h1v1h-1z`)));
    return { commands, size: data.length };
  }, [text]);
  return (
    <svg class="qr" viewBox={`0 0 ${path.size} ${path.size}`} role="img" aria-label={label} shape-rendering="crispEdges">
      <rect width={path.size} height={path.size} fill="#fff" />
      <path d={path.commands} fill="#000" />
    </svg>
  );
}

const FRIENDS_CACHE_KEY = 'pullups:friends';

function readCachedFriends(accountId: string | undefined): Friend[] | null {
  try {
    const cached = JSON.parse(localStorage.getItem(FRIENDS_CACHE_KEY) ?? 'null') as { accountId: string; friends: Friend[] } | null;
    return cached && cached.accountId === accountId ? cached.friends : null;
  } catch {
    return null;
  }
}

export function FriendsTab({ tracker, onOpenSettings, onOpenProfile }: { tracker: Tracker; onOpenSettings: () => void; onOpenProfile: (userId: string) => void }) {
  const token = tracker.settings.token;
  const accountId = tracker.account?.id;
  const [friends, setFriends] = useState<Friend[] | null>(() => readCachedFriends(accountId));
  const [friendLink, setFriendLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirmingRemoveId, setConfirmingRemoveId] = useState<string | null>(null);
  const [isConfirmingRotate, setIsConfirmingRotate] = useState(false);

  const refresh = async () => {
    if (!token) return;
    try {
      const response = await fetchFriends(token);
      setFriends(response.friends);
      setFriendLink(response.friendLink);
      setError(null);
      try {
        localStorage.setItem(FRIENDS_CACHE_KEY, JSON.stringify({ accountId, friends: response.friends }));
      } catch {}
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
    }
  };
  useEffect(() => {
    void refresh();
  }, [token, accountId]);

  if (!token) {
    return (
      <div class="friends">
        <section class="card">
          <h2 class="card__title">Friends</h2>
          <p class="muted">Sign in to add friends and see each other's boards.</p>
          <div class="sheet__actions sheet__actions--inline">
            <button type="button" class="btn btn--primary" onClick={onOpenSettings}>
              Sign in or create an account
            </button>
          </div>
        </section>
      </div>
    );
  }

  const url = friendLink ? joinLink(friendLink) : null;
  const remove = async (friend: Friend) => {
    setConfirmingRemoveId(null);
    try {
      await removeFriend(friend.id, token);
      setFriends((current) => current?.filter((other) => other.id !== friend.id) ?? null);
    } catch (removeError) {
      setNote(removeError instanceof Error ? removeError.message : String(removeError));
    }
  };
  const rotate = async () => {
    setIsConfirmingRotate(false);
    try {
      setFriendLink((await rotateFriendLink(token)).friendLink);
      setNote('New link made. The old one no longer works; friends you already have stay.');
    } catch (rotateError) {
      setNote(rotateError instanceof Error ? rotateError.message : String(rotateError));
    }
  };

  return (
    <div class="friends">
      <FriendsBoard tracker={tracker} onOpenProfile={onOpenProfile} />
      <section class="card">
        <header class="card__head">
          <h2>Friends</h2>
          <span class="muted small">{friends ? friends.length : ''}</span>
        </header>
        {error && !friends ? <p class="muted small">{error}</p> : null}
        {friends?.length === 0 ? <p class="muted small">No friends yet. Send someone your link below; opening it makes you friends.</p> : null}
        <ul class="people">
          {friends?.map((friend) => (
            <li key={friend.id}>
              <button type="button" class="people__name people__link" onClick={() => onOpenProfile(friend.id)}>
                {friend.name}
              </button>
              {confirmingRemoveId === friend.id ? (
                <span>
                  <button type="button" class="btn-text btn-text--danger" onClick={() => void remove(friend)}>
                    Remove
                  </button>
                  <button type="button" class="btn-text" onClick={() => setConfirmingRemoveId(null)}>
                    Keep
                  </button>
                </span>
              ) : (
                <button type="button" class="btn-text btn-text--quiet" aria-label={`Remove ${friend.name}`} onClick={() => setConfirmingRemoveId(friend.id)}>
                  Remove…
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section class="card">
        <header class="card__head">
          <h2>Your friend link</h2>
        </header>
        <p class="muted small">Anyone who opens it becomes your friend: they see your totals and you see theirs. It works until you make a new one.</p>
        {url ? (
          <>
            <QrCode text={url} label="QR code of your friend link" />
            <div class="field">
              <div class="token-row">
                <input type="text" readOnly aria-label="Your friend link" value={url} onFocus={(event) => (event.target as HTMLInputElement).select()} />
                <button type="button" class="btn-text" onClick={() => void shareUrl(url).then(setNote)}>
                  {'share' in navigator ? 'Share' : 'Copy'}
                </button>
              </div>
            </div>
            {isConfirmingRotate ? (
              <p class="muted small">
                The old link stops working.{' '}
                <button type="button" class="btn-text" onClick={() => void rotate()}>
                  Make a new link
                </button>{' '}
                <button type="button" class="btn-text" onClick={() => setIsConfirmingRotate(false)}>
                  Cancel
                </button>
              </p>
            ) : (
              <button type="button" class="btn-text btn-text--quiet" onClick={() => setIsConfirmingRotate(true)}>
                Make a new link…
              </button>
            )}
          </>
        ) : (
          <p class="muted small">{error ?? 'Loading…'}</p>
        )}
        {note ? <p class="muted small">{note}</p> : null}
      </section>
    </div>
  );
}

/**
 * Where an opened friend or challenge link lands. Signed in, one tap redeems it. Signed out,
 * a name and a passkey make an account that comes with the friendship, or a passkey sign-in
 * redeems it afterwards.
 */
export function LinkSheet({ tracker, code, onClose, onRedeemed }: { tracker: Tracker; code: string; onClose: () => void; onRedeemed: (message: string) => void }) {
  const [resolved, setResolved] = useState<ResolvedLink | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busyAction, setBusyAction] = useState<'redeem' | 'signup' | 'signin' | null>(null);
  const token = tracker.settings.token;
  const cleanedName = cleanName(name);

  useEffect(() => {
    resolveLink(code).then(setResolved, (resolveError) => setError(resolveError instanceof Error ? resolveError.message : String(resolveError)));
  }, [code]);

  const finish = (friendName: string) => {
    onRedeemed(`You and ${friendName} are friends.`);
    onClose();
  };
  const redeemWith = async (sessionToken: string) => finish((await redeemLink(code, sessionToken)).friend.name);
  const act = async (action: 'redeem' | 'signup' | 'signin') => {
    setBusyAction(action);
    setError(null);
    try {
      if (action === 'redeem') await redeemWith(token);
      else if (action === 'signup') {
        const response = await signUpWithPasskey({ name: cleanedName!, timeZone: tracker.deviceTimeZone, dailyGoalReps: tracker.goal(), linkCode: code });
        tracker.signIn(response.token, response.account);
        void tracker.syncNow();
        if (response.redeemed) finish(response.redeemed.friend.name);
        else {
          setError('Your account is made, but this link stopped working along the way.');
          setBusyAction(null);
        }
        return;
      } else {
        const response = await signInWithPasskey();
        tracker.signIn(response.token, response.account);
        void tracker.syncNow();
        await redeemWith(response.token);
      }
    } catch (actionError) {
      setError(passkeyErrorMessage(actionError));
      setBusyAction(null);
    }
  };

  return (
    <Sheet title={resolved ? `${resolved.inviterName} invited you` : 'Invitation'} onClose={onClose}>
      {resolved ? (
        <p class="link-lead">
          <b>{resolved.inviterName}</b> wants to be friends on Pull-ups. Friends see each other's daily totals and boards.
        </p>
      ) : error ? null : (
        <p class="muted">Opening the link…</p>
      )}
      {resolved && token ? (
        <div class="sheet__actions">
          <button type="button" class="btn btn--primary" disabled={busyAction !== null} onClick={() => void act('redeem')}>
            {busyAction ? 'Adding…' : `Add ${resolved.inviterName}`}
          </button>
        </div>
      ) : null}
      {resolved && !token && isPasskeySupported() ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (cleanedName) void act('signup');
          }}
        >
          <label class="field">
            <span>Your name</span>
            <input type="text" maxLength={MAX_NAME_LENGTH} autocomplete="nickname" value={name} onInput={(event) => setName((event.target as HTMLInputElement).value)} />
          </label>
          <p class="muted small">Then Face ID, a fingerprint or your device PIN makes your passkey. No email, no password.</p>
          <div class="sheet__actions sheet__actions--inline">
            <button type="submit" class="btn btn--primary" disabled={!cleanedName || busyAction !== null}>
              {busyAction === 'signup' ? 'Joining…' : 'Join'}
            </button>
            <button type="button" class="btn" disabled={busyAction !== null} onClick={() => void act('signin')}>
              {busyAction === 'signin' ? 'Signing in…' : 'I have an account'}
            </button>
          </div>
        </form>
      ) : null}
      {resolved && !token && !isPasskeySupported() ? <p class="muted small">This browser can't use passkeys, which accounts need. Try Safari on iPhone or Chrome on Android.</p> : null}
      {error ? <p class="muted small">{error}</p> : null}
    </Sheet>
  );
}
