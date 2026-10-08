import { useRef, useState } from 'preact/hooks';
import { type Entry, formatLbs } from '../shared/model';
import type { Stats } from '../shared/stats';
import { dayKey, formatClock } from '../shared/time';
import { Ring } from './charts';
import { haptic } from './hooks';
import type { Tracker } from './tracker';

const QUICK = [3, 4, 5, 6, 7, 8];
/** A second tap this soon after the last one is almost always a fat-finger, not a new set. */
const DOUBLE_TAP_GUARD_MS = 600;

interface TodayProps {
  tracker: Tracker;
  stats: Stats;
  now: number;
  usual: number | null;
  onLogged: (e: Entry) => void;
  onEdit: (e: Entry) => void;
  onCustom: () => void;
  onSetup: () => void;
  onWeight: () => void;
}

export function Today({ tracker, stats, now, usual, onLogged, onEdit, onCustom, onSetup, onWeight }: TodayProps) {
  const lastTap = useRef(0);
  const [pressed, setPressed] = useState<number | null>(null);
  const goal = tracker.settings.goal;
  const today = dayKey(now);
  const sets = tracker
    .all()
    .filter((e) => !e.deleted && dayKey(e.ts) === today)
    .sort((a, b) => b.ts - a.ts);
  const { reps } = stats.today;
  const left = goal - reps;
  const padLbs = tracker.padLbs(today);

  const log = (n: number) => {
    const t = Date.now();
    if (t - lastTap.current < DOUBLE_TAP_GUARD_MS) return;
    lastTap.current = t;
    haptic(14);
    setPressed(n);
    setTimeout(() => setPressed(null), 260);
    onLogged(tracker.add(n, Date.now(), padLbs));
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
            <div class="hero__sub">{left > 0 ? `${left} to go` : left === 0 ? 'Goal hit' : `+${-left} over goal`}</div>
          </div>
        </div>
        <div class="hero__meta">
          <span>
            <b>{sets.length}</b> {sets.length === 1 ? 'set' : 'sets'}
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
        <button type="button" class="banner" onClick={onSetup}>
          Logging works offline. <u>Open an invite link</u> to back up, sync across devices and join the board.
        </button>
      ) : null}

      <section class="today-sets" aria-label="Today's sets">
        {sets.length ? (
          <ul class="set-chips">
            {sets.map((e) => (
              <li key={e.id}>
                <button type="button" class="set-chip" onClick={() => onEdit(e)} aria-label={`${e.reps} reps${e.lbs ? ` with ${e.lbs} pounds` : ''} at ${formatClock(e.ts)}, edit`}>
                  <b>{e.reps}</b>
                  {e.lbs ? <em class="set-chip__lbs">{formatLbs(e.lbs)}</em> : null}
                  <span>{formatClock(e.ts)}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p class="empty">No sets yet today. Tap a number below after each set.</p>
        )}
      </section>

      <section class={`pad${padLbs ? ' is-weighted' : ''}`} aria-label="Log a set">
        <button type="button" class="pad__weight" onClick={onWeight} aria-label={`Added weight: ${padLbs ? `${padLbs} pounds` : 'none'}. Change`}>
          <span class="muted">Weight</span>
          <b>{padLbs ? formatLbs(padLbs) : 'Bodyweight'}</b>
        </button>
        <div class="pad__grid">
          {QUICK.map((n) => (
            <button
              key={n}
              type="button"
              class={`pad__btn${n === usual ? ' is-usual' : ''}${pressed === n ? ' is-pressed' : ''}`}
              onClick={() => log(n)}
              aria-label={`Log ${n} reps${padLbs ? ` with ${padLbs} pounds` : ''}`}
            >
              {n}
            </button>
          ))}
        </div>
        <button type="button" class="pad__other" onClick={onCustom}>
          Other amount or time…
        </button>
      </section>
    </div>
  );
}
