import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { type Entry, MAX_HOLD_SECONDS, exerciseIdOf, formatAddedWeight } from '../shared/model';
import { type SetContext, type SetTemplate, lastContextFor, lastSet, padCounts, padHoldSeconds, recentExerciseIds, recentVariationIds, repeatableSessions, templateOf, toggleVariation, usualAmount } from '../shared/pad';
import type { Stats } from '../shared/stats';
import { addDays, dayKey, formatClock, formatDay } from '../shared/time';
import { describeSet, exerciseLabel, exerciseName, formatAmount, formatHoldSeconds } from './labels';
import { Ring } from './charts';
import { haptic } from './hooks';
import { ExercisePickerSheet, VariationSheet, variationLabel } from './pickers';
import type { Tracker } from './tracker';

/** A second tap this soon after the last one is almost always a fat-finger, not a new set. */
const DOUBLE_TAP_GUARD_MS = 600;
const RECENT_EXERCISE_CHIPS = 4;
const RECENT_VARIATION_CHIPS = 4;
const SESSIONS_OFFERED = 2;

/** A past session loaded for repeating: each Log logs the current item and moves on. */
interface Queue {
  items: SetTemplate[];
  index: number;
}

interface TodayProps {
  tracker: Tracker;
  stats: Stats;
  now: number;
  timeZone: string;
  onLogged: (entry: Entry) => void;
  onEdit: (entry: Entry) => void;
  onOpenCustomEntry: (context: SetContext) => void;
  onOpenSettings: () => void;
  onOpenPadWeight: (exerciseId: string) => void;
  /** Absent until the composer is available. */
  onOpenDescribe?: () => void;
  onToast: (text: string) => void;
}

const contextKey = (context: SetContext) => `${context.exerciseId}|${context.variationIds.join(',')}`;

export function Today({ tracker, stats, now, timeZone, onLogged, onEdit, onOpenCustomEntry, onOpenSettings, onOpenPadWeight, onOpenDescribe, onToast }: TodayProps) {
  const lastTapAtMs = useRef(0);
  const [pressedAmount, setPressedAmount] = useState<number | null>(null);
  const [chosenAmount, setChosenAmount] = useState<number | null>(null);
  const [queue, setQueue] = useState<Queue | null>(null);
  const [picker, setPicker] = useState<'exercise' | 'variation' | null>(null);
  const [timerStartedAtMs, setTimerStartedAtMs] = useState<number | null>(null);
  const [, setTimerTick] = useState(0);

  const entries = tracker.allEntries();
  const goal = tracker.goal();
  const today = dayKey(now, timeZone);
  const queueItem = queue ? queue.items[queue.index]! : null;
  const context: SetContext = queueItem ?? tracker.padContext();
  const exercise = tracker.exercise(context.exerciseId);
  const isTimed = exercise?.measure === 'time';
  const usual = useMemo(() => usualAmount(entries, context, now, timeZone), [entries, contextKey(context), now, timeZone]);
  const padAmounts = isTimed ? padHoldSeconds(usual) : padCounts(usual, exercise?.unit);
  const queuedAmount = queueItem ? (queueItem.reps ?? queueItem.holdSeconds) : undefined;
  const amount = chosenAmount ?? queuedAmount ?? usual ?? padAmounts[2]!;
  const addedWeightLbs = queueItem ? (queueItem.addedWeightLbs ?? 0) : tracker.padAddedWeightLbs(today, context.exerciseId);

  useEffect(() => setChosenAmount(null), [contextKey(context), queue?.index]);
  useEffect(() => {
    if (timerStartedAtMs === null) return;
    const interval = setInterval(() => setTimerTick((tick) => tick + 1), 250);
    return () => clearInterval(interval);
  }, [timerStartedAtMs]);

  const todaysSets = entries.filter((entry) => !entry.deleted && dayKey(entry.doneAt, timeZone) === today).sort((a, b) => b.doneAt - a.doneAt);
  const { reps } = stats.today;
  const repsLeft = goal - reps;
  const recentExercises = useMemo(() => {
    const exerciseIds = recentExerciseIds(entries, RECENT_EXERCISE_CHIPS + 1).filter((exerciseId) => exerciseId !== context.exerciseId);
    return [context.exerciseId, ...exerciseIds].slice(0, RECENT_EXERCISE_CHIPS);
  }, [entries, context.exerciseId]);
  const variationChips = useMemo(() => [...new Set([...context.variationIds, ...recentVariationIds(entries, context.exerciseId, RECENT_VARIATION_CHIPS)])], [entries, contextKey(context)]);
  const previous = lastSet(entries);
  const sessions = useMemo(() => repeatableSessions(entries, now, SESSIONS_OFFERED), [entries, now]);

  const guardDoubleTap = () => {
    const tapAtMs = Date.now();
    if (tapAtMs - lastTapAtMs.current < DOUBLE_TAP_GUARD_MS) return false;
    lastTapAtMs.current = tapAtMs;
    return true;
  };

  const changeContext = (next: SetContext) => {
    if (queue) {
      const items = [...queue.items];
      const current = items[queue.index]!;
      const isSameMeasure = tracker.exercise(next.exerciseId)?.measure === tracker.exercise(current.exerciseId)?.measure;
      items[queue.index] = isSameMeasure ? { ...current, ...next } : { exerciseId: next.exerciseId, variationIds: next.variationIds, addedWeightLbs: current.addedWeightLbs };
      setQueue({ ...queue, items });
    } else {
      tracker.setPadContext(next);
    }
  };

  const log = () => {
    if (!guardDoubleTap()) return;
    haptic(14);
    setPressedAmount(amount);
    setTimeout(() => setPressedAmount(null), 260);
    const template: SetTemplate = { ...context, addedWeightLbs };
    if (isTimed) template.holdSeconds = amount;
    else template.reps = amount;
    onLogged(tracker.logTemplate(template));
    if (queue) advanceQueue();
  };

  const advanceQueue = () => {
    if (!queue) return;
    if (queue.index + 1 < queue.items.length) setQueue({ ...queue, index: queue.index + 1 });
    else {
      setQueue(null);
      onToast('Session done');
    }
  };

  const repeatLastSet = () => {
    if (!previous || !guardDoubleTap()) return;
    haptic(14);
    onLogged(tracker.logTemplate(templateOf(previous)));
  };

  const toggleTimer = () => {
    haptic(10);
    if (timerStartedAtMs === null) {
      setTimerStartedAtMs(Date.now());
      return;
    }
    const elapsedSeconds = Math.min(MAX_HOLD_SECONDS, Math.max(1, Math.round((Date.now() - timerStartedAtMs) / 1000)));
    setTimerStartedAtMs(null);
    setChosenAmount(elapsedSeconds);
  };

  const amountLabel = isTimed ? formatHoldSeconds(amount) : exercise?.unit && exercise.unit !== 'rep' ? `${amount} ${amount === 1 ? exercise.unit : `${exercise.unit}s`}` : String(amount);
  const configLabel = context.variationIds.map((variationId) => variationLabel(tracker, context.exerciseId, variationId)).join(', ');
  const logLabel = [amountLabel, exerciseName(context.exerciseId, tracker), configLabel].filter(Boolean).join(' · ') + (addedWeightLbs ? ` @ ${formatAddedWeight(addedWeightLbs)}` : '');

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
          Logging works offline. <u>Sign in or create an account</u> to back up, sync across devices and add friends.
        </button>
      ) : null}

      <section class={`pad${addedWeightLbs ? ' is-weighted' : ''}`} aria-label="Log a set">
        {queue ? (
          <div class="queue">
            <span class="queue__progress">
              Set {queue.index + 1} of {queue.items.length}
            </span>
            <button type="button" class="btn-text" onClick={advanceQueue}>
              Skip
            </button>
            <button type="button" class="btn-text btn-text--quiet" onClick={() => setQueue(null)}>
              Stop
            </button>
          </div>
        ) : null}

        <div class="pad__grid">
          {padAmounts.map((padAmount) => (
            <button
              key={padAmount}
              type="button"
              class={`pad__btn${padAmount === amount ? ' is-on' : ''}${padAmount === usual ? ' is-usual' : ''}${pressedAmount === padAmount ? ' is-pressed' : ''}`}
              aria-pressed={padAmount === amount}
              onClick={() => {
                haptic(6);
                setChosenAmount(padAmount);
              }}
            >
              {isTimed ? formatHoldSeconds(padAmount) : padAmount}
              {!isTimed && exercise?.unit && exercise.unit !== 'rep' ? <small class="pad__unit">{exercise.unit}s</small> : null}
            </button>
          ))}
        </div>
        {isTimed ? (
          <button type="button" class={`pad__timer${timerStartedAtMs !== null ? ' is-running' : ''}`} onClick={toggleTimer}>
            {timerStartedAtMs === null ? 'Start timer' : `Stop · ${formatHoldSeconds(Math.max(0, Math.floor((Date.now() - timerStartedAtMs) / 1000))) }`}
          </button>
        ) : null}

        <div class="pad__row" role="group" aria-label="Exercise">
          {recentExercises.map((exerciseId) => (
            <button
              key={exerciseId}
              type="button"
              class={`chip${exerciseId === context.exerciseId ? ' is-on' : ''}`}
              aria-pressed={exerciseId === context.exerciseId}
              onClick={() => exerciseId !== context.exerciseId && changeContext(lastContextFor(entries, exerciseId))}
            >
              {exerciseName(exerciseId, tracker)}
            </button>
          ))}
          <button type="button" class="chip chip--more" onClick={() => setPicker('exercise')}>
            More…
          </button>
        </div>

        <div class="pad__row" role="group" aria-label="Configuration">
          {variationChips.map((variationId) => (
            <button
              key={variationId}
              type="button"
              class={`chip${context.variationIds.includes(variationId) ? ' is-on' : ''}`}
              aria-pressed={context.variationIds.includes(variationId)}
              onClick={() => changeContext({ ...context, variationIds: toggleVariation(context.variationIds, variationId) })}
            >
              {variationLabel(tracker, context.exerciseId, variationId)}
            </button>
          ))}
          <button type="button" class="chip chip--more" aria-label="Add a configuration" onClick={() => setPicker('variation')}>
            {variationChips.length ? '+' : '+ Configuration'}
          </button>
          <button type="button" class="chip chip--weight" disabled={!!queue} onClick={() => onOpenPadWeight(context.exerciseId)} aria-label={`Added weight: ${addedWeightLbs ? `${addedWeightLbs} pounds` : 'none'}. Change`}>
            {addedWeightLbs ? formatAddedWeight(addedWeightLbs) : 'BW'}
          </button>
        </div>

        <button type="button" class="pad__log" onClick={log}>
          Log {logLabel}
        </button>

        <div class="pad__repeat">
          {previous && !queue ? (
            <button type="button" class="chip" onClick={repeatLastSet} aria-label={`Repeat last set: ${describeSet(previous, tracker)}`}>
              ↻ {formatAmount(previous, tracker)} {exerciseName(exerciseIdOf(previous), tracker)}
            </button>
          ) : null}
          {!queue
            ? sessions.map((session) => (
                <button key={session.startMs} type="button" class="chip" onClick={() => setQueue({ items: session.entries.map(templateOf), index: 0 })} aria-label={`Repeat the session of ${session.entries.length} sets`}>
                  ↻ {sessionDayLabel(session.startMs, today, timeZone)} · {session.entries.length} sets
                </button>
              ))
            : null}
        </div>
        <div class="pad__more">
          {onOpenDescribe ? (
            <button type="button" class="pad__other" onClick={onOpenDescribe}>
              ✎ Describe what you did…
            </button>
          ) : null}
          <button type="button" class="pad__other" onClick={() => onOpenCustomEntry(context)}>
            Other amount or time…
          </button>
        </div>
      </section>

      <section class="today-sets" aria-label="Today's sets">
        {todaysSets.length ? (
          <ul class="set-chips">
            {todaysSets.map((entry) => (
              <li key={entry.id}>
                <button type="button" class="set-chip" onClick={() => onEdit(entry)} aria-label={`${describeSet(entry, tracker)} at ${formatClock(entry.doneAt, timeZone)}, edit`}>
                  <b>{formatAmount(entry, tracker)}</b>
                  {exerciseLabel(entry, tracker) ? <em class="set-chip__exercise">{exerciseLabel(entry, tracker)}</em> : null}
                  {entry.addedWeightLbs ? <em class="set-chip__lbs">{formatAddedWeight(entry.addedWeightLbs)}</em> : null}
                  <span>{formatClock(entry.doneAt, timeZone)}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p class="empty">No sets yet today. Pick a number and Log after each set.</p>
        )}
      </section>

      {picker === 'exercise' ? (
        <ExercisePickerSheet
          tracker={tracker}
          onClose={() => setPicker(null)}
          onPick={(exerciseId) => {
            changeContext(lastContextFor(entries, exerciseId));
            setPicker(null);
          }}
        />
      ) : null}
      {picker === 'variation' ? <VariationSheet tracker={tracker} exerciseId={context.exerciseId} variationIds={context.variationIds} onChange={(variationIds) => changeContext({ ...context, variationIds })} onClose={() => setPicker(null)} /> : null}
    </div>
  );
}

function sessionDayLabel(startMs: number, today: string, timeZone: string): string {
  const day = dayKey(startMs, timeZone);
  if (day === today) return 'Earlier';
  if (day === addDays(today, -1)) return 'Yesterday';
  return formatDay(day, { weekday: true }).split(',')[0]!;
}
