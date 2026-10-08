import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { type Entry, MAX_LBS, MAX_REPS, MIN_REPS, clampLbs, formatLbs, isValidEntry } from '../shared/model';
import { dailyTotals } from '../shared/stats';
import { dayKey, formatClock, formatDay, timeOfDay, wallToEpoch } from '../shared/time';
import { haptic } from './hooks';
import type { Tracker } from './tracker';

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ComponentChildren }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div class="sheet-wrap" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="sheet" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
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
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label: string;
  format?: (n: number) => string;
  small?: boolean;
}

function Stepper({ value, onChange, min = MIN_REPS, max = MAX_REPS, step = 1, label, format = String, small }: StepperProps) {
  const set = (n: number) => {
    haptic(6);
    onChange(Math.min(max, Math.max(min, n)));
  };
  return (
    <div class={`stepper${small ? ' stepper--small' : ''}`} role="group" aria-label={label}>
      <button type="button" class="stepper__btn" onClick={() => set(value - step)} disabled={value <= min} aria-label="Decrease">
        −
      </button>
      <output class="stepper__val" aria-live="polite">
        {format(value)}
      </output>
      <button type="button" class="stepper__btn" onClick={() => set(value + step)} disabled={value >= max} aria-label="Increase">
        +
      </button>
    </div>
  );
}

const LBS_CHIPS = [0, 5, 10, 15, 20, 25, 35, 45, 55, 70, 90];

/** Added weight in 2.5 lb steps, with chips for common plate/dumbbell loads. 0 is bodyweight. */
function WeightPicker({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <div class="weight-picker">
      <Stepper value={value} onChange={(n) => onChange(clampLbs(n))} min={0} max={MAX_LBS} step={2.5} label="Added weight in pounds" format={(n) => (n ? formatLbs(n) : 'BW')} small />
      <div class="chips" role="group" aria-label="Common added weights">
        {LBS_CHIPS.map((n) => (
          <button key={n} type="button" class={`chip${n === value ? ' is-on' : ''}`} onClick={() => onChange(n)}>
            {n ? `+${n}` : 'BW'}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Chooses the added weight the quick pad logs with, for the rest of today. */
export function PadWeightSheet({ tracker, now, onClose }: { tracker: Tracker; now: number; onClose: () => void }) {
  const today = dayKey(now);
  const [lbs, setLbs] = useState(tracker.padLbs(today));
  return (
    <Sheet title="Added weight" onClose={onClose}>
      <WeightPicker value={lbs} onChange={setLbs} />
      <p class="muted small">Quick-tap sets use this weight until midnight, then go back to bodyweight.</p>
      <div class="sheet__actions">
        <button
          type="button"
          class="btn btn--primary"
          onClick={() => {
            haptic(15);
            tracker.setPadLbs(lbs, today);
            onClose();
          }}
        >
          {lbs ? `Use ${formatLbs(lbs)}` : 'Use bodyweight'}
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
  defaultLbs?: number;
  now: number;
  onClose: () => void;
  onLogged?: (e: Entry) => void;
  onDeleted?: (e: Entry) => void;
}

export function EntrySheet({ tracker, entry, day, defaultReps, defaultLbs = 0, now, onClose, onLogged, onDeleted }: EntrySheetProps) {
  const today = dayKey(now);
  const initialDay = entry ? dayKey(entry.ts) : (day ?? today);
  const [reps, setReps] = useState(entry?.reps ?? defaultReps);
  const [lbs, setLbs] = useState(entry ? (entry.lbs ?? 0) : defaultLbs);
  const [date, setDate] = useState(initialDay);
  // Only an explicitly chosen time is converted; "now" keeps second precision and ordering.
  const [time, setTime] = useState(entry ? timeOfDay(entry.ts) : initialDay === today ? timeOfDay(now) : '12:00');
  const [timeTouched, setTimeTouched] = useState(false);

  const resolveTs = () => {
    if (entry) return date === dayKey(entry.ts) && time === timeOfDay(entry.ts) ? entry.ts : wallToEpoch(date, time);
    if (!timeTouched && date === today) return Date.now();
    return wallToEpoch(date, time);
  };

  const save = () => {
    haptic(15);
    if (entry) {
      tracker.update(entry.id, { reps, lbs, ts: resolveTs() });
    } else {
      onLogged?.(tracker.add(reps, resolveTs(), lbs));
    }
    onClose();
  };

  return (
    <Sheet title={entry ? 'Edit set' : 'Log a set'} onClose={onClose}>
      <Stepper value={reps} onChange={setReps} label="Reps" />
      <div class="chips" role="group" aria-label="Common rep counts">
        {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15].map((n) => (
          <button key={n} type="button" class={`chip${n === reps ? ' is-on' : ''}`} onClick={() => setReps(n)}>
            {n}
          </button>
        ))}
      </div>
      <h3 class="sheet__sub">Added weight</h3>
      <WeightPicker value={lbs} onChange={setLbs} />
      <div class="field-row">
        <label class="field">
          <span>Day</span>
          <input type="date" value={date} max={today} onInput={(e) => setDate((e.target as HTMLInputElement).value || date)} />
        </label>
        <label class="field">
          <span>Time</span>
          <input
            type="time"
            value={time}
            onInput={(e) => {
              setTime((e.target as HTMLInputElement).value || time);
              setTimeTouched(true);
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
          {entry ? 'Save' : `Log ${reps}${lbs ? ` @ ${formatLbs(lbs)}` : ''}`}
        </button>
      </div>
    </Sheet>
  );
}

export function DaySheet({ tracker, day, goal, onClose, onEdit, onAdd }: { tracker: Tracker; day: string; goal: number; onClose: () => void; onEdit: (e: Entry) => void; onAdd: () => void }) {
  const sets = tracker
    .all()
    .filter((e) => !e.deleted && dayKey(e.ts) === day)
    .sort((a, b) => a.ts - b.ts);
  const total = dailyTotals(sets).get(day);
  return (
    <Sheet title={formatDay(day, { weekday: true, year: true })} onClose={onClose}>
      <p class="day-sum">
        <b>{total?.reps ?? 0}</b> reps · {sets.length} {sets.length === 1 ? 'set' : 'sets'}
        {(total?.reps ?? 0) >= goal ? <span class="badge-good">✓ Goal</span> : null}
      </p>
      {sets.length ? (
        <ul class="set-list">
          {sets.map((e) => (
            <li key={e.id}>
              <button type="button" class="set-row" onClick={() => onEdit(e)}>
                <span class="set-row__time">{formatClock(e.ts)}</span>
                <span class="set-row__reps">
                  {e.reps}
                  {e.lbs ? <em class="set-row__lbs">{formatLbs(e.lbs)}</em> : null}
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
  auth: 'Token rejected',
  unconfigured: 'Sync is not set up',
};

export function SettingsSheet({ tracker, onClose }: { tracker: Tracker; onClose: () => void }) {
  const [token, setToken] = useState(tracker.settings.token);
  const [show, setShow] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const tokenInput = {
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: false,
    placeholder: 'Paste the token from deploy',
    value: token,
    onInput: (e: Event) => setToken((e.target as HTMLInputElement).value),
  } as const;

  const saveToken = () => {
    tracker.updateSettings({ token: token.trim() });
    void tracker.syncNow();
    setMsg('Saved. Syncing…');
  };

  const download = (name: string, type: string, body: string) => {
    const url = URL.createObjectURL(new Blob([body], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const stamp = dayKey(Date.now());
  const exportJson = () => download(`pullups-${stamp}.json`, 'application/json', JSON.stringify({ v: 1, entries: tracker.all() }, null, 1));
  const exportCsv = () => {
    const rows = tracker
      .all()
      .filter((e) => !e.deleted)
      .sort((a, b) => a.ts - b.ts)
      .map((e) => `${dayKey(e.ts)},${timeOfDay(e.ts)},${e.reps},${e.lbs ?? 0},${new Date(e.ts).toISOString()}`);
    download(`pullups-${stamp}.csv`, 'text/csv', ['day,time_denver,reps,added_lbs,timestamp_utc', ...rows].join('\n'));
  };
  const importJson = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as { entries?: unknown[] };
      const valid = (parsed.entries ?? []).filter(isValidEntry);
      const n = tracker.importEntries(valid);
      setMsg(`Imported ${n} new or newer entries (${valid.length} read).`);
    } catch {
      setMsg('That file is not a pull-up export.');
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
        <label class="field">
          <span>Access token</span>
          <div class="token-row">
            {show ? <input type="text" {...tokenInput} /> : <input type="password" {...tokenInput} />}
            <button type="button" class="btn-text" onClick={() => setShow(!show)}>
              {show ? 'Hide' : 'Show'}
            </button>
          </div>
        </label>
        <div class="sheet__actions sheet__actions--inline">
          <button type="button" class="btn btn--primary" onClick={saveToken} disabled={!token.trim()}>
            Save &amp; sync
          </button>
          <button type="button" class="btn" onClick={() => void tracker.syncNow()} disabled={!tracker.settings.token}>
            Sync now
          </button>
        </div>
        {msg ? <p class="muted small">{msg}</p> : null}
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
          <button type="button" class="btn" onClick={() => fileRef.current?.click()}>
            Import JSON
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = (e.target as HTMLInputElement).files?.[0];
              if (f) void importJson(f);
            }}
          />
        </div>
      </section>
      <p class="muted small version">Build {__BUILD_ID__}</p>
    </Sheet>
  );
}
