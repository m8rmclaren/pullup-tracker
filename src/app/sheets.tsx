import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { type Entry, type PasskeySummary, MAX_ADDED_WEIGHT_LBS, MAX_HOLD_SECONDS, MAX_NAME_LENGTH, MAX_REPS, MIN_HOLD_SECONDS, MIN_REPS, clampAddedWeight, cleanName, exerciseIdOf, formatAddedWeight, isValidEntry } from '../shared/model';
import { MIN_DAILY_GOAL_REPS } from '../shared/profile';
import { dailyTotals } from '../shared/stats';
import { dayKey, formatClock, formatDay, timeOfDay, wallClockToEpochMs } from '../shared/time';
import { addPasskey, createDeviceLink, deviceLink, isPasskeySupported, listPasskeys, parseDeviceLink, parseJoinLink, passkeyErrorMessage, redeemDeviceLink, signInWithPasskey, signUpWithPasskey } from './api';
import { exerciseLabel, formatAmount, formatHoldSeconds, unitLookup } from './labels';
import { haptic } from './hooks';
import type { Tracker } from './tracker';

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ComponentChildren }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKeyDown);
    dialogRef.current?.focus();
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);
  return (
    <div class="sheet-wrap" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div class="sheet" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={dialogRef}>
        <div class="sheet__grab" aria-hidden="true" />
        <header class="sheet__head">
          <h2>{title}</h2>
          <button type="button" class="btn-text" onClick={onClose}>
            Close
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

interface StepperProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label: string;
  format?: (value: number) => string;
  small?: boolean;
}

function Stepper({ value, onChange, min = MIN_REPS, max = MAX_REPS, step = 1, label, format = String, small }: StepperProps) {
  const changeTo = (nextValue: number) => {
    haptic(6);
    onChange(Math.min(max, Math.max(min, nextValue)));
  };
  return (
    <div class={`stepper${small ? ' stepper--small' : ''}`} role="group" aria-label={label}>
      <button type="button" class="stepper__btn" onClick={() => changeTo(value - step)} disabled={value <= min} aria-label="Decrease">
        −
      </button>
      <output class="stepper__val" aria-live="polite">
        {format(value)}
      </output>
      <button type="button" class="stepper__btn" onClick={() => changeTo(value + step)} disabled={value >= max} aria-label="Increase">
        +
      </button>
    </div>
  );
}

const ADDED_WEIGHT_CHIPS_LBS = [0, 5, 10, 15, 20, 25, 35, 45, 55, 70, 90];

/** Added weight in 2.5 lb steps, with chips for common plate/dumbbell loads. 0 is bodyweight. */
function WeightPicker({ value, onChange }: { value: number; onChange: (addedWeightLbs: number) => void }) {
  return (
    <div class="weight-picker">
      <Stepper
        value={value}
        onChange={(addedWeightLbs) => onChange(clampAddedWeight(addedWeightLbs))}
        min={0}
        max={MAX_ADDED_WEIGHT_LBS}
        step={2.5}
        label="Added weight in pounds"
        format={(addedWeightLbs) => (addedWeightLbs ? formatAddedWeight(addedWeightLbs) : 'BW')}
        small
      />
      <div class="chips" role="group" aria-label="Common added weights">
        {ADDED_WEIGHT_CHIPS_LBS.map((chipLbs) => (
          <button key={chipLbs} type="button" class={`chip${chipLbs === value ? ' is-on' : ''}`} onClick={() => onChange(chipLbs)}>
            {chipLbs ? `+${chipLbs}` : 'BW'}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Chooses the added weight the quick pad logs with, for the rest of today. */
export function PadWeightSheet({ tracker, now, timeZone, onClose }: { tracker: Tracker; now: number; timeZone: string; onClose: () => void }) {
  const today = dayKey(now, timeZone);
  const [addedWeightLbs, setAddedWeightLbs] = useState(tracker.padAddedWeightLbs(today));
  return (
    <Sheet title="Added weight" onClose={onClose}>
      <WeightPicker value={addedWeightLbs} onChange={setAddedWeightLbs} />
      <p class="muted small">Quick-tap sets use this weight until midnight, then go back to bodyweight.</p>
      <div class="sheet__actions">
        <button
          type="button"
          class="btn btn--primary"
          onClick={() => {
            haptic(15);
            tracker.setPadAddedWeight(addedWeightLbs, today);
            onClose();
          }}
        >
          {addedWeightLbs ? `Use ${formatAddedWeight(addedWeightLbs)}` : 'Use bodyweight'}
        </button>
      </div>
    </Sheet>
  );
}

const REP_CHIPS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15];
const HOLD_CHIPS_SECONDS = [10, 15, 20, 30, 45, 60, 90, 120];

interface EntrySheetProps {
  tracker: Tracker;
  /** Edit this entry; otherwise create a new one. */
  entry?: Entry;
  /** For new entries: the day to log into (defaults to today). */
  day?: string;
  defaultReps: number;
  /** For new entries: the starting added weight. */
  defaultAddedWeightLbs?: number;
  now: number;
  timeZone: string;
  onClose: () => void;
  onLogged?: (entry: Entry) => void;
  onDeleted?: (entry: Entry) => void;
}

export function EntrySheet({ tracker, entry, day, defaultReps, defaultAddedWeightLbs = 0, now, timeZone, onClose, onLogged, onDeleted }: EntrySheetProps) {
  const today = dayKey(now, timeZone);
  const initialDay = entry ? dayKey(entry.doneAt, timeZone) : (day ?? today);
  const isHold = entry?.holdSeconds !== undefined;
  const [amount, setAmount] = useState(entry?.reps ?? entry?.holdSeconds ?? defaultReps);
  const [addedWeightLbs, setAddedWeightLbs] = useState(entry ? (entry.addedWeightLbs ?? 0) : defaultAddedWeightLbs);
  const [date, setDate] = useState(initialDay);
  // Only an explicitly chosen time is converted; "now" keeps second precision and ordering.
  const [time, setTime] = useState(entry ? timeOfDay(entry.doneAt, timeZone) : initialDay === today ? timeOfDay(now, timeZone) : '12:00');
  const [isTimeTouched, setIsTimeTouched] = useState(false);

  const resolveDoneAt = () => {
    if (entry) return date === dayKey(entry.doneAt, timeZone) && time === timeOfDay(entry.doneAt, timeZone) ? entry.doneAt : wallClockToEpochMs(date, time, timeZone);
    if (!isTimeTouched && date === today) return Date.now();
    return wallClockToEpochMs(date, time, timeZone);
  };

  const save = () => {
    haptic(15);
    if (entry) {
      tracker.update(entry.id, isHold ? { holdSeconds: amount, addedWeightLbs, doneAt: resolveDoneAt() } : { reps: amount, addedWeightLbs, doneAt: resolveDoneAt() });
    } else {
      onLogged?.(tracker.add(amount, resolveDoneAt(), addedWeightLbs));
    }
    onClose();
  };

  return (
    <Sheet title={entry ? `Edit set${exerciseLabel(entry, tracker) ? ` · ${exerciseLabel(entry, tracker)}` : ''}` : 'Log a set'} onClose={onClose}>
      {isHold ? <Stepper value={amount} onChange={setAmount} min={MIN_HOLD_SECONDS} max={MAX_HOLD_SECONDS} label="Seconds" format={formatHoldSeconds} /> : <Stepper value={amount} onChange={setAmount} label="Reps" />}
      <div class="chips" role="group" aria-label={isHold ? 'Common hold times' : 'Common rep counts'}>
        {(isHold ? HOLD_CHIPS_SECONDS : REP_CHIPS).map((chipAmount) => (
          <button key={chipAmount} type="button" class={`chip${chipAmount === amount ? ' is-on' : ''}`} onClick={() => setAmount(chipAmount)}>
            {isHold ? formatHoldSeconds(chipAmount) : chipAmount}
          </button>
        ))}
      </div>
      <h3 class="sheet__sub">Added weight</h3>
      <WeightPicker value={addedWeightLbs} onChange={setAddedWeightLbs} />
      <div class="field-row">
        <label class="field">
          <span>Day</span>
          <input type="date" value={date} max={today} onInput={(event) => setDate((event.target as HTMLInputElement).value || date)} />
        </label>
        <label class="field">
          <span>Time</span>
          <input
            type="time"
            value={time}
            onInput={(event) => {
              setTime((event.target as HTMLInputElement).value || time);
              setIsTimeTouched(true);
            }}
          />
        </label>
      </div>
      <p class="muted small">Times are in {timeZone.replace(/_/g, ' ')}.</p>
      <div class="sheet__actions">
        {entry ? (
          <button
            type="button"
            class="btn btn--danger"
            onClick={() => {
              tracker.remove(entry.id);
              onDeleted?.(entry);
              onClose();
            }}
          >
            Delete
          </button>
        ) : null}
        <button type="button" class="btn btn--primary" onClick={save}>
          {entry ? 'Save' : `Log ${amount}${addedWeightLbs ? ` @ ${formatAddedWeight(addedWeightLbs)}` : ''}`}
        </button>
      </div>
    </Sheet>
  );
}

export function DaySheet({ tracker, day, timeZone, goal, onClose, onEdit, onAdd }: { tracker: Tracker; day: string; timeZone: string; goal: number; onClose: () => void; onEdit: (entry: Entry) => void; onAdd: () => void }) {
  const daySets = tracker
    .allEntries()
    .filter((entry) => !entry.deleted && dayKey(entry.doneAt, timeZone) === day)
    .sort((a, b) => a.doneAt - b.doneAt);
  const dayTotal = dailyTotals(daySets, timeZone, unitLookup(tracker)).get(day);
  return (
    <Sheet title={formatDay(day, { weekday: true, year: true })} onClose={onClose}>
      <p class="day-sum">
        <b>{dayTotal?.reps ?? 0}</b> reps · {daySets.length} {daySets.length === 1 ? 'set' : 'sets'}
        {(dayTotal?.reps ?? 0) >= goal ? <span class="badge-good">✓ Goal</span> : null}
      </p>
      {daySets.length ? (
        <ul class="set-list">
          {daySets.map((entry) => (
            <li key={entry.id}>
              <button type="button" class="set-row" onClick={() => onEdit(entry)}>
                <span class="set-row__time">{formatClock(entry.doneAt, timeZone)}</span>
                <span class="set-row__reps">
                  {formatAmount(entry, tracker)}
                  {exerciseLabel(entry, tracker) ? <em class="set-row__exercise">{exerciseLabel(entry, tracker)}</em> : null}
                  {entry.addedWeightLbs ? <em class="set-row__lbs">{formatAddedWeight(entry.addedWeightLbs)}</em> : null}
                </span>
                <span class="set-row__edit muted">Edit</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p class="muted">No sets this day.</p>
      )}
      <div class="sheet__actions">
        <button type="button" class="btn" onClick={onAdd}>
          Add a set to this day
        </button>
      </div>
    </Sheet>
  );
}

const STATUS_TEXT: Record<Tracker['status'], string> = {
  synced: 'All changes synced',
  syncing: 'Syncing…',
  pending: 'Changes waiting to sync',
  offline: "Can't reach the server — will retry",
  auth: 'Signed out',
  outdated: 'This version is too old to sync',
  unconfigured: 'Not signed in — sets stay on this device',
};

/** A link pasted into Settings: an iPhone home-screen app never sees links opened in Safari. */
export type PastedLink = { kind: 'device' | 'link'; code: string };

function readPastedLink(text: string): PastedLink | null {
  const deviceCode = parseDeviceLink(text);
  if (deviceCode) return { kind: 'device', code: deviceCode };
  const joinCode = parseJoinLink(text);
  return joinCode ? { kind: 'link', code: joinCode } : null;
}

/** Signs this device into the account a device link belongs to. */
export function DeviceLinkSheet({ tracker, code, onClose }: { tracker: Tracker; code: string; onClose: () => void }) {
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const currentAccount = tracker.settings.token ? tracker.account : null;

  const submit = async (event: Event) => {
    event.preventDefault();
    setIsBusy(true);
    setError(null);
    try {
      const response = await redeemDeviceLink(code);
      tracker.signIn(response.token, response.account);
      void tracker.syncNow();
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
      setIsBusy(false);
    }
  };

  return (
    <Sheet title="Sign in this device" onClose={onClose}>
      <form onSubmit={(event) => void submit(event)}>
        <p class="muted">This link signs this device into your account. Sets already logged here are added to it.</p>
        {currentAccount ? <p class="muted small">This device is signed in as {currentAccount.name}; continuing switches it.</p> : null}
        {error ? <p class="muted small">{error}</p> : null}
        <div class="sheet__actions">
          <button type="submit" class="btn btn--primary" disabled={isBusy}>
            {isBusy ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

/** Signed out: make an account with a name and a passkey, or sign in with one. */
function SignedOutSection({ tracker, onOpenLink }: { tracker: Tracker; onOpenLink: (link: PastedLink) => void }) {
  const [name, setName] = useState('');
  const [pastedLink, setPastedLink] = useState('');
  const [busyAction, setBusyAction] = useState<'signup' | 'signin' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const cleanedName = cleanName(name);

  const signInWith = async (action: 'signup' | 'signin') => {
    setBusyAction(action);
    setNote(null);
    try {
      const response = action === 'signup' ? await signUpWithPasskey(cleanedName!, tracker.deviceTimeZone) : await signInWithPasskey();
      tracker.signIn(response.token, response.account);
      void tracker.syncNow();
    } catch (error) {
      setNote(passkeyErrorMessage(error));
    }
    setBusyAction(null);
  };
  const openPastedLink = () => {
    const link = readPastedLink(pastedLink);
    if (link) onOpenLink(link);
    else setNote("That doesn't look like a link from this app.");
  };

  return (
    <>
      {isPasskeySupported() ? (
        <>
          <p class="muted small">An account is a name and a passkey: Face ID, a fingerprint or your device's PIN. No email, no password. Your passkey syncs through your password manager, so a new phone signs straight back in. Lose every device and the password manager, and the account is gone.</p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (cleanedName) void signInWith('signup');
            }}
          >
            <label class="field">
              <span>Your name</span>
              <input type="text" maxLength={MAX_NAME_LENGTH} autocomplete="nickname" value={name} onInput={(event) => setName((event.target as HTMLInputElement).value)} />
            </label>
            <div class="sheet__actions sheet__actions--inline">
              <button type="submit" class="btn btn--primary" disabled={!cleanedName || busyAction !== null}>
                {busyAction === 'signup' ? 'Creating…' : 'Create account'}
              </button>
              <button type="button" class="btn" disabled={busyAction !== null} onClick={() => void signInWith('signin')}>
                {busyAction === 'signin' ? 'Signing in…' : 'Sign in with a passkey'}
              </button>
            </div>
          </form>
        </>
      ) : (
        <p class="muted small">This browser can't use passkeys. Open a device link from another of your devices to sign in here.</p>
      )}
      <label class="field">
        <span>Or paste a link</span>
        <div class="token-row">
          <input type="text" autocomplete="off" autocapitalize="off" spellcheck={false} value={pastedLink} onInput={(event) => setPastedLink((event.target as HTMLInputElement).value)} />
          <button type="button" class="btn-text" onClick={openPastedLink} disabled={!pastedLink.trim()}>
            Use
          </button>
        </div>
      </label>
      {note ? <p class="muted small">{note}</p> : null}
    </>
  );
}

function SignedInSection({ tracker, onOpenLink }: { tracker: Tracker; onOpenLink: (link: PastedLink) => void }) {
  const token = tracker.settings.token;
  const [passkeys, setPasskeys] = useState<PasskeySummary[] | null>(null);
  const [createdLink, setCreatedLink] = useState<string | null>(null);
  const [pastedLink, setPastedLink] = useState('');
  const [isAddingPasskey, setIsAddingPasskey] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    listPasskeys(token).then(
      (response) => setPasskeys(response.passkeys),
      () => setPasskeys(null),
    );
  }, [token]);

  const addThisDevicesPasskey = async () => {
    setIsAddingPasskey(true);
    setNote(null);
    try {
      setPasskeys((await addPasskey(token)).passkeys);
      setNote('Passkey added. Wiping this browser or getting a new phone now signs straight back in.');
    } catch (error) {
      setNote(passkeyErrorMessage(error));
    }
    setIsAddingPasskey(false);
  };
  const createLink = async () => {
    setNote(null);
    try {
      setCreatedLink(deviceLink((await createDeviceLink(token)).code));
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    }
  };
  const shareLink = async () => {
    if (!createdLink) return;
    try {
      if (navigator.share) await navigator.share({ url: createdLink });
      else {
        await navigator.clipboard.writeText(createdLink);
        setNote('Copied.');
      }
    } catch {}
  };
  const openPastedLink = () => {
    const link = readPastedLink(pastedLink);
    if (link) onOpenLink(link);
    else setNote("That doesn't look like a link from this app.");
  };

  return (
    <>
      <p>
        Signed in as <b>{tracker.accountName() ?? '…'}</b>
      </p>
      {passkeys ? (
        passkeys.length ? (
          <ul class="passkeys">
            {passkeys.map((passkey) => (
              <li key={passkey.credentialId}>
                <span>{passkey.label ?? 'Passkey'}</span>
                <span class="muted small">added {formatDay(dayKey(passkey.createdAt, tracker.timeZone()), { year: true })}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p class="muted small">No passkey yet. Add one so this account can sign back in after a wipe or on a new phone.</p>
        )
      ) : null}
      <div class="sheet__actions sheet__actions--inline">
        {isPasskeySupported() ? (
          <button type="button" class="btn" disabled={isAddingPasskey} onClick={() => void addThisDevicesPasskey()}>
            {isAddingPasskey ? 'Adding…' : 'Add a passkey'}
          </button>
        ) : null}
        <button type="button" class="btn" onClick={() => void createLink()}>
          Add another device
        </button>
      </div>
      {createdLink ? (
        <>
          <div class="field">
            <div class="token-row">
              <input type="text" readOnly aria-label="Link to send" value={createdLink} onFocus={(event) => (event.target as HTMLInputElement).select()} />
              <button type="button" class="btn-text" onClick={() => void shareLink()}>
                {'share' in navigator ? 'Share' : 'Copy'}
              </button>
            </div>
          </div>
          <p class="muted small">Open it on your other device within 15 minutes. On iPhone, paste it under Settings in the home-screen app, not Safari.</p>
        </>
      ) : null}
      <label class="field">
        <span>Paste a friend, challenge or device link</span>
        <div class="token-row">
          <input type="text" autocomplete="off" autocapitalize="off" spellcheck={false} value={pastedLink} onInput={(event) => setPastedLink((event.target as HTMLInputElement).value)} />
          <button type="button" class="btn-text" onClick={openPastedLink} disabled={!pastedLink.trim()}>
            Use
          </button>
        </div>
      </label>
      {note ? <p class="muted small">{note}</p> : null}
    </>
  );
}

function ProfileSection({ tracker }: { tracker: Tracker }) {
  const savedName = tracker.accountName() ?? '';
  const [name, setName] = useState(savedName);
  const timeZone = tracker.timeZone();
  const deviceTimeZone = tracker.deviceTimeZone;
  const zones = useMemo(() => {
    let supported: string[] = [];
    try {
      supported = Intl.supportedValuesOf('timeZone');
    } catch {}
    return [...new Set([...supported, timeZone, deviceTimeZone])].sort();
  }, [timeZone, deviceTimeZone]);
  const cleanedName = cleanName(name);

  return (
    <>
      <label class="field">
        <span>Your name</span>
        <div class="token-row">
          <input type="text" maxLength={MAX_NAME_LENGTH} autocomplete="nickname" value={name} onInput={(event) => setName((event.target as HTMLInputElement).value)} />
          <button type="button" class="btn-text" disabled={!cleanedName || cleanedName === savedName} onClick={() => cleanedName && tracker.updateProfile({ name: cleanedName })}>
            Save
          </button>
        </div>
      </label>
      <label class="field">
        <span>Time zone</span>
        <select value={timeZone} onChange={(event) => tracker.updateProfile({ timeZone: (event.target as HTMLSelectElement).value })}>
          {zones.map((zone) => (
            <option key={zone} value={zone}>
              {zone.replace(/_/g, ' ')}
            </option>
          ))}
        </select>
      </label>
      {timeZone !== deviceTimeZone ? (
        <p class="muted small">
          This device is in {deviceTimeZone.replace(/_/g, ' ')}.{' '}
          <button type="button" class="btn-text" onClick={() => tracker.updateProfile({ timeZone: deviceTimeZone })}>
            Use it
          </button>
        </p>
      ) : null}
      <p class="muted small">Your days start at midnight here. Changing it moves your last 62 days into the new zone; older days stay as they were.</p>
    </>
  );
}

/** Fetches the newest service worker, which precaches the new build, then reloads into it. */
async function reloadIntoLatestVersion(): Promise<void> {
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    await registration?.update();
    const worker = registration?.installing ?? registration?.waiting;
    if (worker) {
      const isSettled = () => worker.state === 'activated' || worker.state === 'redundant';
      await Promise.race([
        new Promise((resolve) => (isSettled() ? resolve(null) : worker.addEventListener('statechange', () => isSettled() && resolve(null)))),
        new Promise((resolve) => setTimeout(resolve, 10_000)),
      ]);
    }
  } catch {}
  location.reload();
}

export function SettingsSheet({ tracker, onClose, onOpenLink }: { tracker: Tracker; onClose: () => void; onOpenLink: (link: PastedLink) => void }) {
  const [dataMessage, setDataMessage] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  const downloadFile = (fileName: string, mimeType: string, body: string) => {
    const url = URL.createObjectURL(new Blob([body], { type: mimeType }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const timeZone = tracker.timeZone();
  const exportDay = dayKey(Date.now(), timeZone);
  const exportJson = () => downloadFile(`pullups-${exportDay}.json`, 'application/json', JSON.stringify({ version: 1, entries: tracker.allEntries() }, null, 1));
  const exportCsv = () => {
    const rows = tracker
      .allEntries()
      .filter((entry) => !entry.deleted)
      .sort((a, b) => a.doneAt - b.doneAt)
      .map((entry) => `${dayKey(entry.doneAt, timeZone)},${timeOfDay(entry.doneAt, timeZone)},${entry.reps ?? ''},${entry.addedWeightLbs ?? 0},${new Date(entry.doneAt).toISOString()},${exerciseIdOf(entry)},${entry.holdSeconds ?? ''},${(entry.variationIds ?? []).join(' ')}`);
    downloadFile(`pullups-${exportDay}.csv`, 'text/csv', ['day,time_local,reps,added_lbs,timestamp_utc,exercise,hold_seconds,variations', ...rows].join('\n'));
  };
  const importJson = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as { entries?: unknown[] };
      const validEntries = (parsed.entries ?? []).filter(isValidEntry);
      const importedCount = tracker.importEntries(validEntries);
      setDataMessage(`Imported ${importedCount} new or newer entries (${validEntries.length} read).`);
    } catch {
      setDataMessage('That file is not a pull-up export.');
    }
  };

  return (
    <Sheet title="Settings" onClose={onClose}>
      <section class="settings-sec">
        <h3>Sync</h3>
        <p class={`sync-line sync-line--${tracker.status}`}>
          <i class="dot" /> {STATUS_TEXT[tracker.status]}
          {tracker.pendingCount() ? ` · ${tracker.pendingCount()} queued` : ''}
        </p>
        {tracker.lastError && tracker.status !== 'synced' ? <p class="muted small">{tracker.lastError}</p> : null}
        <p class="muted small">
          {tracker.lastSyncAt ? `Last synced ${formatDay(dayKey(tracker.lastSyncAt, timeZone))} at ${formatClock(tracker.lastSyncAt, timeZone)}` : 'Never synced from this device'}
        </p>
        {tracker.status === 'outdated' ? (
          <div class="sheet__actions sheet__actions--inline">
            <button type="button" class="btn btn--primary" onClick={() => void reloadIntoLatestVersion()}>
              Update now
            </button>
          </div>
        ) : tracker.settings.token ? (
          <div class="sheet__actions sheet__actions--inline">
            <button type="button" class="btn" onClick={() => void tracker.syncNow()}>
              Sync now
            </button>
          </div>
        ) : null}
      </section>

      <section class="settings-sec">
        <h3>Account</h3>
        {tracker.settings.token ? <SignedInSection tracker={tracker} onOpenLink={onOpenLink} /> : <SignedOutSection tracker={tracker} onOpenLink={onOpenLink} />}
      </section>

      {tracker.settings.token ? (
        <section class="settings-sec">
          <h3>Profile</h3>
          <ProfileSection tracker={tracker} />
        </section>
      ) : null}

      <section class="settings-sec">
        <h3>Daily goal</h3>
        <Stepper value={tracker.goal()} min={MIN_DAILY_GOAL_REPS} max={500} label="Daily goal" onChange={(dailyGoalReps) => tracker.updateProfile({ dailyGoalReps })} />
        <p class="muted small">{tracker.settings.token ? 'Saved to your account, so every device agrees.' : 'Stored on this device until you join.'}</p>
      </section>

      <section class="settings-sec">
        <h3>Your data</h3>
        <div class="sheet__actions sheet__actions--inline">
          <button type="button" class="btn" onClick={exportCsv}>
            Export CSV
          </button>
          <button type="button" class="btn" onClick={exportJson}>
            Export JSON
          </button>
          <button type="button" class="btn" onClick={() => importInputRef.current?.click()}>
            Import JSON
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(event) => {
              const file = (event.target as HTMLInputElement).files?.[0];
              if (file) void importJson(file);
            }}
          />
        </div>
        {dataMessage ? <p class="muted small">{dataMessage}</p> : null}
      </section>
      <p class="muted small version">Build {__BUILD_ID__}</p>
    </Sheet>
  );
}
