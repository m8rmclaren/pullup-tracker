import { useEffect, useMemo, useState } from 'preact/hooks';
import { type BoardDay, type BoardMetric, type BoardPeriod, type BoardRow, type BoardSpec, evaluateBoard, requestWindow } from '../shared/boards';
import { builtInExercise } from '../shared/catalog';
import type { Definition, ExerciseDefinition } from '../shared/definitions';
import type { LeaderboardResponse, ProfileViewResponse } from '../shared/model';
import { exerciseDayTotals } from '../shared/stats';
import { addDays, dayKey, formatDay } from '../shared/time';
import { fetchLeaderboard, fetchProfile } from './api';
import { formatHoldSeconds } from './labels';
import { Sheet } from './sheets';
import type { ExerciseInfo, Tracker } from './tracker';

export const METRIC_LABELS: Record<BoardMetric, string> = { count: 'Total', sets: 'Sets', bestSet: 'Best set', activeDays: 'Days active', goalPercent: '% of goal' };
const PERIOD_LABELS = { today: 'Today', week: 'Week', month: 'Month' } as const;
/** The default to try (product.md, open question 7): days active this week, ties broken by count, which easy reps can't game. */
const DEFAULT_SPEC: BoardSpec = { metric: 'activeDays', period: 'week' };
const SPEC_KEY = 'pullups:board';

/** Built-ins from the catalog, created ones from this device or from what a response carried. */
export function exerciseLookup(tracker: Tracker, definitions: Definition[]): (exerciseId: string) => ExerciseInfo | undefined {
  const fromResponse = new Map(definitions.map((definition) => [definition.id, definition as ExerciseDefinition]));
  return (exerciseId) => builtInExercise(exerciseId) ?? tracker.exercise(exerciseId) ?? fromResponse.get(exerciseId);
}

/** A metric value in words: "12 laps", "1m 30s", "3 days", "85%". */
export function formatMetric(metric: BoardMetric, value: number | null, exercise: ExerciseInfo | undefined): string {
  if (value === null) return 'no goal';
  if (metric === 'goalPercent') return `${Math.round(value)}%`;
  if (metric === 'activeDays') return `${value} ${value === 1 ? 'day' : 'days'}`;
  if (metric === 'sets') return `${value} ${value === 1 ? 'set' : 'sets'}`;
  if (exercise?.measure === 'time') return formatHoldSeconds(value);
  const unit = exercise?.unit ?? 'rep';
  return `${value.toLocaleString()} ${value === 1 ? unit : `${unit}s`}`;
}

export function BoardRows({ rows, metric, exercise, myId, onOpen }: { rows: BoardRow[]; metric: BoardMetric; exercise: ExerciseInfo | undefined; myId?: string; onOpen?: (row: BoardRow) => void }) {
  return (
    <ol class="board">
      {rows.map((row) => (
        <li key={row.id} class={row.id === myId ? 'is-me' : ''}>
          <button type="button" class="board__row" disabled={!onOpen} onClick={() => onOpen?.(row)}>
            <span class="board__rank">{row.rank ?? '–'}</span>
            <span class="board__name">{row.id === myId ? `${row.name} (you)` : row.name}</span>
            <span class="board__value">{formatMetric(metric, row.value, exercise)}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

function readSavedSpec(): BoardSpec {
  try {
    return { ...DEFAULT_SPEC, ...(JSON.parse(localStorage.getItem(SPEC_KEY) ?? '{}') as Partial<BoardSpec>) };
  } catch {
    return DEFAULT_SPEC;
  }
}

/** You and your friends, ranked on this device from raw day totals; the server never ranks. */
export function FriendsBoard({ tracker, onOpenProfile }: { tracker: Tracker; onOpenProfile: (userId: string) => void }) {
  const token = tracker.settings.token;
  const [spec, setSpec] = useState<BoardSpec>(readSavedSpec);
  const [response, setResponse] = useState<LeaderboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const period = spec.period as Exclude<BoardPeriod, object>;

  useEffect(() => {
    try {
      localStorage.setItem(SPEC_KEY, JSON.stringify(spec));
    } catch {}
  }, [spec]);
  useEffect(() => {
    let isCurrent = true;
    fetchLeaderboard(requestWindow(period, Date.now(), tracker.timeZone()), token).then(
      (fetched) => isCurrent && (setResponse(fetched), setError(null)),
      (fetchError) => isCurrent && setError(fetchError instanceof Error ? fetchError.message : String(fetchError)),
    );
    return () => {
      isCurrent = false;
    };
  }, [token, period]);

  const lookup = useMemo(() => exerciseLookup(tracker, response?.definitions ?? []), [tracker, response]);
  const exerciseIds = useMemo(() => {
    const seen = new Set<string>();
    for (const user of response?.users ?? []) for (const day of user.days) for (const exerciseId of Object.keys(exerciseDayTotals(day))) seen.add(exerciseId);
    return [...seen].sort((a, b) => (lookup(a)?.name ?? a).localeCompare(lookup(b)?.name ?? b));
  }, [response, lookup]);
  const rows = useMemo(() => (response ? evaluateBoard(spec, response.users, Date.now()) : []), [response, spec]);
  const exercise = spec.exerciseId ? lookup(spec.exerciseId) : undefined;

  return (
    <section class="card">
      <header class="card__head">
        <h2>Board</h2>
        <div class="seg" role="tablist" aria-label="Period">
          {(['today', 'week', 'month'] as const).map((option) => (
            <button key={option} type="button" role="tab" class={period === option ? 'is-on' : ''} aria-selected={period === option} onClick={() => setSpec({ ...spec, period: option })}>
              {PERIOD_LABELS[option]}
            </button>
          ))}
        </div>
      </header>
      <div class="board-controls">
        <select aria-label="Rank by" value={spec.metric} onChange={(event) => setSpec({ ...spec, metric: (event.target as HTMLSelectElement).value as BoardMetric })}>
          {(Object.keys(METRIC_LABELS) as BoardMetric[]).map((metric) => (
            <option key={metric} value={metric}>
              {METRIC_LABELS[metric]}
            </option>
          ))}
        </select>
        <select
          aria-label="Exercise"
          value={spec.exerciseId ?? ''}
          disabled={spec.metric === 'goalPercent'}
          onChange={(event) => {
            const exerciseId = (event.target as HTMLSelectElement).value;
            setSpec(exerciseId ? { ...spec, exerciseId } : { metric: spec.metric, period: spec.period });
          }}
        >
          <option value="">All exercises</option>
          {[...new Set([...exerciseIds, ...(spec.exerciseId ? [spec.exerciseId] : [])])].map((exerciseId) => (
            <option key={exerciseId} value={exerciseId}>
              {lookup(exerciseId)?.name ?? 'Unknown exercise'}
            </option>
          ))}
        </select>
      </div>
      {response ? <BoardRows rows={rows} metric={spec.metric} exercise={exercise} myId={tracker.account?.id} onOpen={(row) => onOpenProfile(row.id)} /> : <p class="muted small">{error ?? 'Loading…'}</p>}
      {response && response.users.length === 1 ? <p class="muted small">Just you so far. Share your friend link below to fill the board.</p> : null}
    </section>
  );
}

function currentStreak(days: BoardDay[], today: string): number {
  const activeDays = new Set(days.filter((day) => day.sets > 0).map((day) => day.day));
  let day = activeDays.has(today) ? today : addDays(today, -1);
  let streak = 0;
  while (activeDays.has(day)) {
    streak++;
    day = addDays(day, -1);
  }
  return streak;
}

/** A friend's profile: their ring today, streak, recent days and every exercise they've logged. */
export function ProfileSheet({ tracker, userId, onClose }: { tracker: Tracker; userId: string; onClose: () => void }) {
  const [view, setView] = useState<ProfileViewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetchProfile(userId, tracker.settings.token).then(setView, (fetchError) => setError(fetchError instanceof Error ? fetchError.message : String(fetchError)));
  }, [userId]);
  const lookup = useMemo(() => exerciseLookup(tracker, view?.definitions ?? []), [tracker, view]);

  if (!view) {
    return (
      <Sheet title="Profile" onClose={onClose}>
        <p class="muted">{error ?? 'Loading…'}</p>
      </Sheet>
    );
  }
  const today = dayKey(Date.now(), view.profile.timeZone);
  const todayTotal = view.days.find((day) => day.day === today);
  const streak = currentStreak(view.days, today);
  const recentDays = [...view.days].reverse().slice(0, 14);
  const maxReps = Math.max(1, view.profile.dailyGoalReps ?? 0, ...recentDays.map((day) => day.reps));

  return (
    <Sheet title={view.profile.name} onClose={onClose}>
      <div class="tiles">
        <div class="tile">
          <div class="tile__label">Today</div>
          <div class="tile__value">
            {todayTotal?.reps ?? 0} <span class="tile__unit">{view.profile.dailyGoalReps ? `/ ${view.profile.dailyGoalReps}` : 'reps'}</span>
          </div>
        </div>
        <div class="tile">
          <div class="tile__label">Streak</div>
          <div class="tile__value">
            {streak} <span class="tile__unit">{streak === 1 ? 'day' : 'days'}</span>
          </div>
        </div>
      </div>
      <h3 class="sheet__subhead">Exercises</h3>
      <ul class="people">
        {view.exercises.map((summary) => {
          const exercise = lookup(summary.exerciseId);
          const total = summary.totals.holdSeconds !== undefined ? formatMetric('count', summary.totals.holdSeconds, exercise) : formatMetric('count', summary.totals.reps ?? 0, exercise);
          const best = summary.bests.bestHoldSeconds !== undefined ? formatHoldSeconds(summary.bests.bestHoldSeconds) : summary.bests.bestSetReps;
          return (
            <li key={summary.exerciseId}>
              <span class="people__name">{exercise?.name ?? 'Unknown exercise'}</span>
              <span class="muted small">
                {total} · best {best}
                {summary.bests.bestAddedWeightLbs ? ` · +${summary.bests.bestAddedWeightLbs} lb` : ''}
              </span>
            </li>
          );
        })}
        {view.exercises.length === 0 ? <li class="muted small">Nothing logged yet.</li> : null}
      </ul>
      <h3 class="sheet__subhead">Recent days</h3>
      <ul class="history">
        {recentDays.map((day) => (
          <li key={day.day}>
            <div class="history__row">
              <span class="history__day">{day.day === today ? 'Today' : formatDay(day.day, { weekday: true })}</span>
              <span class="history__bar" aria-hidden="true">
                <i style={{ width: `${Math.min(100, (100 * day.reps) / maxReps)}%` }} class={view.profile.dailyGoalReps && day.reps >= view.profile.dailyGoalReps ? 'is-hit' : ''} />
              </span>
              <span class="history__reps">{day.reps}</span>
              <span class="history__sets muted">{day.sets}×</span>
            </div>
          </li>
        ))}
        {recentDays.length === 0 ? <li class="muted small">No days in the last 90.</li> : null}
      </ul>
    </Sheet>
  );
}
