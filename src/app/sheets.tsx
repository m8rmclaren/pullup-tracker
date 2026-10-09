import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { type Entry, type InviteKind, MAX_ADDED_WEIGHT_LBS, MAX_NAME_LENGTH, MAX_REPS, MIN_REPS, clampAddedWeight, formatAddedWeight, isValidEntry } from '../shared/model';
import { dailyTotals } from '../shared/stats';
import { dayKey, formatClock, formatDay, timeOfDay, wallClockToEpochMs } from '../shared/time';
import { createInvite, inviteLink, join, parseInviteLink } from './api';
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
export function PadWeightSheet({ tracker, now, onClose }: { tracker: Tracker; now: number; onClose: () => void }) {
  const today = dayKey(now);
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
  onClose: () => void;
  onLogged?: (entry: Entry) => void;
  onDeleted?: (entry: Entry) => void;
}

export function EntrySheet({ tracker, entry, day, defaultReps, defaultAddedWeightLbs = 0, now, onClose, onLogged, onDeleted }: EntrySheetProps) {
  const today = dayKey(now);
  const initialDay = entry ? dayKey(entry.doneAt) : (day ?? today);
  const [reps, setReps] = useState(entry?.reps ?? defaultReps);
  const [addedWeightLbs, setAddedWeightLbs] = useState(entry ? (entry.addedWeightLbs ?? 0) : defaultAddedWeightLbs);
  const [date, setDate] = useState(initialDay);
  // Only an explicitly chosen time is converted; "now" keeps second precision and ordering.
  const [time, setTime] = useState(entry ? timeOfDay(entry.doneAt) : initialDay === today ? timeOfDay(now) : '12:00');
  const [isTimeTouched, setIsTimeTouched] = useState(false);

  const resolveDoneAt = () => {
    if (entry) return date === dayKey(entry.doneAt) && time === timeOfDay(entry.doneAt) ? entry.doneAt : wallClockToEpochMs(date, time);
    if (!isTimeTouched && date === today) return Date.now();
    return wallClockToEpochMs(date, time);
  };

  const save = () => {
    haptic(15);
    if (entry) {
      tracker.update(entry.id, { reps, addedWeightLbs, doneAt: resolveDoneAt() });
    } else {
      onLogged?.(tracker.add(reps, resolveDoneAt(), addedWeightLbs));
    }
    onClose();
  };

  return (
    <Sheet title={entry ? 'Edit set' : 'Log a set'} onClose={onClose}>
      <Stepper value={reps} onChange={setReps} label="Reps" />
      <div class="chips" role="group" aria-label="Common rep counts">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15].map((chipReps) => (
          <button key={chipReps} type="button" class={`chip${chipReps === reps ? ' is-on' : ''}`} onClick={() => setReps(chipReps)}>
            {chipReps}
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
      <p class="muted small">Times are Mountain Time (America/Denver).</p>
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
          {entry ? 'Save' : `Log ${reps}${addedWeightLbs ? ` @ ${formatAddedWeight(addedWeightLbs)}` : ''}`}
        </button>
      </div>
    </Sheet>
  );
}

export function DaySheet({ tracker, day, goal, onClose, onEdit, onAdd }: { tracker: Tracker; day: string; goal: number; onClose: () => void; onEdit: (entry: Entry) => void; onAdd: () => void }) {
  const daySets = tracker
    .allEntries()
    .filter((entry) => !entry.deleted && dayKey(entry.doneAt) === day)
    .sort((a, b) => a.doneAt - b.doneAt);
  const dayTotal = dailyTotals(daySets).get(day);
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
                <span class="set-row__time">{formatClock(entry.doneAt)}</span>
                <span class="set-row__reps">
                  {entry.reps}
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
  unconfigured: 'Not signed in — sets stay on this device',
};

export interface PendingInvite {
  kind: InviteKind;
  code: string;
}

export function JoinSheet({ tracker, invite, onClose }: { tracker: Tracker; invite: PendingInvite; onClose: () => void }) {
  const [name, setName] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isFriendInvite = invite.kind === 'friend';
  const currentAccount = tracker.settings.token ? tracker.account : null;

  const submit = async (event: Event) => {
    event.preventDefault();
    setIsBusy(true);
    setError(null);
    try {
      const response = await join({ code: invite.code, name: isFriendInvite ? name : undefined });
      tracker.signIn(response.token, response.account);
      void tracker.syncNow();
      onClose();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
      setIsBusy(false);
    }
  };

  return (
    <Sheet title={isFriendInvite ? 'Join' : 'Sign in this device'} onClose={onClose}>
      <form onSubmit={(event) => void submit(event)}>
        <p class="muted">
          {isFriendInvite
            ? "You've been invited. Pick the name others will see on the board."
            : 'This link signs this device into your account. Sets already logged here are added to it.'}
        </p>
        {currentAccount ? <p class="muted small">This device is signed in as {currentAccount.name}; continuing switches it.</p> : null}
        {isFriendInvite ? (
          <label class="field">
            <span>Your name</span>
            <input type="text" maxLength={MAX_NAME_LENGTH} autocomplete="nickname" value={name} onInput={(event) => setName((event.target as HTMLInputElement).value)} />
          </label>
        ) : null}
        {error ? <p class="muted small">{error}</p> : null}
        <div class="sheet__actions">
          <button type="submit" class="btn btn--primary" disabled={isBusy || (isFriendInvite && !name.trim())}>
            {isBusy ? 'Joining…' : isFriendInvite ? 'Join' : 'Sign in'}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

const INVITE_NOTE: Record<InviteKind, string> = {
  friend: 'Works once and expires in 7 days.',
  device: 'Open it on your other device within 15 minutes. On iPhone, paste it under Settings in the home-screen app, not Safari.',
};

function AccountSection({ tracker, onOpenInvite }: { tracker: Tracker; onOpenInvite: (invite: PendingInvite) => void }) {
  const [createdLink, setCreatedLink] = useState<{ kind: InviteKind; url: string } | null>(null);
  const [pastedLink, setPastedLink] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const token = tracker.settings.token;

  const createLink = async (kind: InviteKind) => {
    setNote(null);
    try {
      const response = await createInvite(kind, token);
      setCreatedLink({ kind, url: inviteLink(kind, response.code) });
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    }
  };
  const shareLink = async () => {
    if (!createdLink) return;
    try {
      if (navigator.share) await navigator.share({ url: createdLink.url });
      else {
        await navigator.clipboard.writeText(createdLink.url);
        setNote('Copied.');
      }
    } catch {}
  };
  const openPastedLink = () => {
    const invite = parseInviteLink(pastedLink);
    if (invite) onOpenInvite(invite);
    else setNote("That doesn't look like an invite or device link.");
  };

  return (
    <>
      {token ? (
        <>
          <p>
            Signed in as <b>{tracker.account?.name ?? '…'}</b>
          </p>
          <div class="sheet__actions sheet__actions--inline">
            <button type="button" class="btn" onClick={() => void createLink('friend')}>
              Invite a friend
            </button>
            <button type="button" class="btn" onClick={() => void createLink('device')}>
              Add another device
            </button>
          </div>
          {createdLink ? (
            <>
              <div class="field">
                <div class="token-row">
                  <input type="text" readOnly aria-label="Link to send" value={createdLink.url} onFocus={(event) => (event.target as HTMLInputElement).select()} />
                  <button type="button" class="btn-text" onClick={() => void shareLink()}>
                    {'share' in navigator ? 'Share' : 'Copy'}
                  </button>
                </div>
              </div>
              <p class="muted small">{INVITE_NOTE[createdLink.kind]}</p>
            </>
          ) : null}
        </>
      ) : null}
      <label class="field">
        <span>{token ? 'Have a link for another account?' : 'Paste an invite or device link'}</span>
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

export function SettingsSheet({ tracker, onClose, onOpenInvite }: { tracker: Tracker; onClose: () => void; onOpenInvite: (invite: PendingInvite) => void }) {
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
  const exportDay = dayKey(Date.now());
  const exportJson = () => downloadFile(`pullups-${exportDay}.json`, 'application/json', JSON.stringify({ version: 1, entries: tracker.allEntries() }, null, 1));
  const exportCsv = () => {
    const rows = tracker
      .allEntries()
      .filter((entry) => !entry.deleted)
      .sort((a, b) => a.doneAt - b.doneAt)
      .map((entry) => `${dayKey(entry.doneAt)},${timeOfDay(entry.doneAt)},${entry.reps},${entry.addedWeightLbs ?? 0},${new Date(entry.doneAt).toISOString()}`);
    downloadFile(`pullups-${exportDay}.csv`, 'text/csv', ['day,time_denver,reps,added_lbs,timestamp_utc', ...rows].join('\n'));
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
          {tracker.lastSyncAt ? `Last synced ${formatDay(dayKey(tracker.lastSyncAt))} at ${formatClock(tracker.lastSyncAt)}` : 'Never synced from this device'}
        </p>
        {tracker.settings.token ? (
          <div class="sheet__actions sheet__actions--inline">
            <button type="button" class="btn" onClick={() => void tracker.syncNow()}>
              Sync now
            </button>
          </div>
        ) : null}
      </section>

      <section class="settings-sec">
        <h3>Account</h3>
        <AccountSection tracker={tracker} onOpenInvite={onOpenInvite} />
      </section>

      <section class="settings-sec">
        <h3>Daily goal</h3>
        <Stepper value={tracker.settings.goal} min={1} max={500} label="Daily goal" onChange={(goal) => tracker.updateSettings({ goal })} />
        <p class="muted small">Stored on this device only.</p>
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
