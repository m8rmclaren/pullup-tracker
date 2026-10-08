import { useRef, useState } from 'preact/hooks';
import { type Entry, formatAddedWeight } from '../shared/model';
import type { Stats } from '../shared/stats';
import { dayKey, formatClock } from '../shared/time';
import { Ring } from './charts';
import { haptic } from './hooks';
import type { Tracker } from './tracker';

const QUICK_REPS = [3, 4, 5, 6, 7, 8];
/** A second tap this soon after the last one is almost always a fat-finger, not a new set. */
const DOUBLE_TAP_GUARD_MS = 600;

interface TodayProps {
  tracker: Tracker;
  stats: Stats;
  now: number;
  usualSetReps: number | null;
  onLogged: (entry: Entry) => void;
  onEdit: (entry: Entry) => void;
  onOpenCustomEntry: () => void;
  onOpenSettings: () => void;
  onOpenPadWeight: () => void;
}

export function Today({ tracker, stats, now, usualSetReps, onLogged, onEdit, onOpenCustomEntry, onOpenSettings, onOpenPadWeight }: TodayProps) {
  const lastTapAtMs = useRef(0);
  const [pressedReps, setPressedReps] = useState<number | null>(null);
  const goal = tracker.settings.goal;
  const today = dayKey(now);
  const todaysSets = tracker
    .allEntries()
    .filter((entry) => !entry.deleted && dayKey(entry.doneAt) === today)
    .sort((a, b) => b.doneAt - a.doneAt);
  const { reps } = stats.today;
  const repsLeft = goal - reps;
  const padAddedWeightLbs = tracker.padAddedWeightLbs(today);

  const logSet = (setReps: number) => {
    const tapAtMs = Date.now();
    if (tapAtMs - lastTapAtMs.current < DOUBLE_TAP_GUARD_MS) return;
    lastTapAtMs.current = tapAtMs;
    haptic(14);
    setPressedReps(setReps);
    setTimeout(() => setPressedReps(null), 260);
    onLogged(tracker.add(setReps, Date.now(), padAddedWeightLbs));
  };

  return (
    <div class="today">
      <section class="hero" aria-label="Today">
        <div class="hero__ring">
          <Ring value={reps} goal={goal} />
          <div class="hero__center">
            <div class="hero__num" key={reps}>
              {reps}
            </div>
            <div class="hero__sub">{repsLeft > 0 ? `${repsLeft} to go` : repsLeft === 0 ? 'Goal hit' : `+${-repsLeft} over goal`}</div>
          </div>
        </div>
        <div class="hero__meta">
          <span>
            <b>{todaysSets.length}</b> {todaysSets.length === 1 ? 'set' : 'sets'}
          </span>
          <span class="sep" />
          <span>
            Goal <b>{goal}</b>
          </span>
          <span class="sep" />
          <span>
            Streak <b>{stats.streak}</b>
            {stats.streak === 1 ? ' day' : ' days'}
          </span>
        </div>
      </section>

      {tracker.status === 'unconfigured' ? (
        <button type="button" class="banner" onClick={onOpenSettings}>
          Logging works offline. <u>Open an invite link</u> to back up, sync across devices and join the board.
        </button>
      ) : null}

      <section class="today-sets" aria-label="Today's sets">
        {todaysSets.length ? (
          <ul class="set-chips">
            {todaysSets.map((entry) => (
              <li key={entry.id}>
                <button type="button" class="set-chip" onClick={() => onEdit(entry)} aria-label={`${entry.reps} reps${entry.addedWeightLbs ? ` with ${entry.addedWeightLbs} pounds` : ''} at ${formatClock(entry.doneAt)}, edit`}>
                  <b>{entry.reps}</b>
                  {entry.addedWeightLbs ? <em class="set-chip__lbs">{formatAddedWeight(entry.addedWeightLbs)}</em> : null}
                  <span>{formatClock(entry.doneAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p class="empty">No sets yet today. Tap a number below after each set.</p>
        )}
      </section>

      <section class={`pad${padAddedWeightLbs ? ' is-weighted' : ''}`} aria-label="Log a set">
        <button type="button" class="pad__weight" onClick={onOpenPadWeight} aria-label={`Added weight: ${padAddedWeightLbs ? `${padAddedWeightLbs} pounds` : 'none'}. Change`}>
          <span class="muted">Weight</span>
          <b>{padAddedWeightLbs ? formatAddedWeight(padAddedWeightLbs) : 'Bodyweight'}</b>
        </button>
        <div class="pad__grid">
          {QUICK_REPS.map((setReps) => (
            <button
              key={setReps}
              type="button"
              class={`pad__btn${setReps === usualSetReps ? ' is-usual' : ''}${pressedReps === setReps ? ' is-pressed' : ''}`}
              onClick={() => logSet(setReps)}
              aria-label={`Log ${setReps} reps${padAddedWeightLbs ? ` with ${padAddedWeightLbs} pounds` : ''}`}
            >
              {setReps}
            </button>
          ))}
        </div>
        <button type="button" class="pad__other" onClick={onOpenCustomEntry}>
          Other amount or time…
        </button>
      </section>
    </div>
  );
}
