import { useEffect, useMemo, useState } from 'preact/hooks';
import { type BoardMetric, challengeBoardMembers, evaluateBoard } from '../shared/boards';
import { allBuiltInExercises, builtInExercise } from '../shared/catalog';
import { type Definition, type ExerciseDefinition, isVariationDefinition } from '../shared/definitions';
import type { Challenge, ChallengeBoardResponse, ChallengeListItem } from '../shared/model';
import { addDays, dayKey, daysBetween, formatDay } from '../shared/time';
import { createChallenge, fetchChallengeBoard, fetchChallengeLink, fetchChallenges, joinLink, leaveChallenge, shareUrl } from './api';
import { BoardRows, METRIC_LABELS, formatMetric } from './Board';
import { QrCode } from './Friends';
import { Sheet } from './sheets';
import type { ExerciseInfo, Tracker } from './tracker';

const MAX_CHALLENGE_DAYS = 62;
/** goalPercent reads the ring, which a challenge board doesn't carry. */
const CHALLENGE_METRICS: BoardMetric[] = ['count', 'sets', 'bestSet', 'activeDays'];

export function challengeExercise(challenge: Challenge, definition: Definition | undefined, tracker: Tracker): ExerciseInfo | undefined {
  return builtInExercise(challenge.exerciseId) ?? (definition as ExerciseDefinition | undefined) ?? tracker.exercise(challenge.exerciseId);
}

export function formatWindow(challenge: Challenge): string {
  const sameYear = challenge.fromDay.slice(0, 4) === challenge.toDay.slice(0, 4);
  return `${formatDay(challenge.fromDay, { year: !sameYear })} – ${formatDay(challenge.toDay, { year: true })}`;
}

/** "412 of 1,000 laps", or "412 laps" with no target. */
export function formatGroupProgress(groupTotal: number, challenge: Challenge, exercise: ExerciseInfo | undefined): string {
  const total = formatMetric('count', groupTotal, exercise);
  return challenge.target ? `${groupTotal.toLocaleString()} of ${formatMetric('count', challenge.target, exercise)}` : total;
}

export function GroupProgress({ groupTotal, challenge, exercise }: { groupTotal: number; challenge: Challenge; exercise: ExerciseInfo | undefined }) {
  return (
    <div class="group-progress">
      <div class="group-progress__total">{formatGroupProgress(groupTotal, challenge, exercise)}</div>
      {challenge.target ? (
        <div class="group-progress__bar" role="progressbar" aria-valuemin={0} aria-valuemax={challenge.target} aria-valuenow={groupTotal}>
          <i style={{ width: `${Math.min(100, (100 * groupTotal) / challenge.target)}%` }} />
        </div>
      ) : null}
    </div>
  );
}

/** Your challenges, with a way to start one. */
export function ChallengesCard({ tracker, onOpenChallenge, onCreate }: { tracker: Tracker; onOpenChallenge: (challengeId: string) => void; onCreate: () => void }) {
  const [items, setItems] = useState<ChallengeListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetchChallenges(tracker.settings.token).then(
      (response) => setItems(response.challenges),
      (fetchError) => setError(fetchError instanceof Error ? fetchError.message : String(fetchError)),
    );
  }, [tracker.settings.token]);
  const today = dayKey(Date.now(), tracker.timeZone());

  return (
    <section class="card">
      <header class="card__head">
        <h2>Challenges</h2>
        <button type="button" class="btn-text" onClick={onCreate}>
          New challenge
        </button>
      </header>
      {items === null ? <p class="muted small">{error ?? 'Loading…'}</p> : null}
      {items?.length === 0 ? <p class="muted small">A challenge is a group working on one exercise for up to two months. Start one and share the link.</p> : null}
      <ul class="people">
        {items?.map((item) => {
          const exercise = challengeExercise(item.challenge, item.definition, tracker);
          const isOver = item.challenge.toDay < today;
          return (
            <li key={item.challenge.id}>
              <button type="button" class="people__link challenge-row" onClick={() => onOpenChallenge(item.challenge.id)}>
                <span class="people__name">{exercise?.name ?? 'Unknown exercise'}</span>
                <span class="muted small">
                  {item.memberCount} {item.memberCount === 1 ? 'person' : 'people'} · {isOver ? 'ended ' : ''}
                  {formatWindow(item.challenge)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Exercises a challenge can be on: the built-ins and the ones this account has made or adopted. */
function availableExercises(tracker: Tracker): { id: string; name: string }[] {
  const created = tracker
    .allDefinitions()
    .filter((definition) => !isVariationDefinition(definition))
    .map((definition) => ({ id: definition.id, name: definition.name }));
  const builtIns = allBuiltInExercises().map((exercise) => ({ id: exercise.id, name: exercise.name }));
  return [...created.sort((a, b) => a.name.localeCompare(b.name)), ...builtIns];
}

export function CreateChallengeSheet({ tracker, onClose, onCreated }: { tracker: Tracker; onClose: () => void; onCreated: (challengeId: string) => void }) {
  const today = dayKey(Date.now(), tracker.timeZone());
  const endOfMonth = addDays(`${addDays(`${today.slice(0, 7)}-28`, 4).slice(0, 7)}-01`, -1);
  const exercises = useMemo(() => availableExercises(tracker), [tracker]);
  const [exerciseId, setExerciseId] = useState(exercises[0]?.id ?? 'pull-up');
  const [fromDay, setFromDay] = useState(today);
  const [toDay, setToDay] = useState(daysBetween(today, endOfMonth) >= 6 ? endOfMonth : addDays(today, 29));
  const [target, setTarget] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dayCount = daysBetween(fromDay, toDay) + 1;
  const targetNumber = target.trim() ? Number(target) : undefined;
  const isValid = dayCount >= 1 && dayCount <= MAX_CHALLENGE_DAYS && toDay >= today && (targetNumber === undefined || (Number.isInteger(targetNumber) && targetNumber > 0));
  const exercise = builtInExercise(exerciseId) ?? tracker.exercise(exerciseId);

  const submit = async (event: Event) => {
    event.preventDefault();
    setIsBusy(true);
    setError(null);
    try {
      const created = await createChallenge({ exerciseId, fromDay, toDay, ...(targetNumber ? { target: targetNumber } : {}) }, tracker.settings.token);
      onCreated(created.challenge.id);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
      setIsBusy(false);
    }
  };

  return (
    <Sheet title="New challenge" onClose={onClose}>
      <form onSubmit={(event) => void submit(event)}>
        <label class="field">
          <span>Exercise</span>
          <select value={exerciseId} onChange={(event) => setExerciseId((event.target as HTMLSelectElement).value)}>
            {exercises.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </label>
        <div class="field-row">
          <label class="field">
            <span>From</span>
            <input type="date" value={fromDay} onInput={(event) => setFromDay((event.target as HTMLInputElement).value)} />
          </label>
          <label class="field">
            <span>To</span>
            <input type="date" value={toDay} min={today} onInput={(event) => setToDay((event.target as HTMLInputElement).value)} />
          </label>
        </div>
        <label class="field">
          <span>Group target ({exercise?.measure === 'time' ? 'seconds' : `${exercise?.unit ?? 'rep'}s`}, optional)</span>
          <input type="number" inputMode="numeric" min={1} value={target} onInput={(event) => setTarget((event.target as HTMLInputElement).value)} />
        </label>
        <p class="muted small">{dayCount > MAX_CHALLENGE_DAYS ? `At most ${MAX_CHALLENGE_DAYS} days.` : `${dayCount} days. Everyone who joins sees each other's totals for this exercise in these days, and nothing else.`}</p>
        {error ? <p class="muted small">{error}</p> : null}
        <div class="sheet__actions">
          <button type="submit" class="btn btn--primary" disabled={!isValid || isBusy}>
            {isBusy ? 'Starting…' : 'Start challenge'}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

/** A challenge: the group total leads, the ranking sits inside, and your own link brings people in. */
export function ChallengeSheet({ tracker, challengeId, onClose, onLeft, onOpenProfile }: { tracker: Tracker; challengeId: string; onClose: () => void; onLeft: () => void; onOpenProfile: (userId: string) => void }) {
  const token = tracker.settings.token;
  const [board, setBoard] = useState<ChallengeBoardResponse | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [metric, setMetric] = useState<BoardMetric>('count');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [isConfirmingLeave, setIsConfirmingLeave] = useState(false);

  useEffect(() => {
    fetchChallengeBoard(challengeId, token).then(setBoard, (fetchError) => setError(fetchError instanceof Error ? fetchError.message : String(fetchError)));
    fetchChallengeLink(challengeId, token).then((response) => setLink(response.link), () => {});
  }, [challengeId, token]);

  const rows = useMemo(() => {
    if (!board) return [];
    const window = { fromDay: board.challenge.fromDay, toDay: board.challenge.toDay };
    return evaluateBoard({ metric, exerciseId: board.challenge.exerciseId, period: window }, challengeBoardMembers(board.challenge.exerciseId, board.members), Date.now());
  }, [board, metric]);

  if (!board) {
    return (
      <Sheet title="Challenge" onClose={onClose}>
        <p class="muted">{error ?? 'Loading…'}</p>
      </Sheet>
    );
  }
  const exercise = challengeExercise(board.challenge, board.definition, tracker);
  const url = link ? joinLink(link) : null;
  const friendIds = new Set(board.members.filter((member) => member.isFriend).map((member) => member.id));
  const leave = async () => {
    try {
      await leaveChallenge(challengeId, token);
      onLeft();
    } catch (leaveError) {
      setNote(leaveError instanceof Error ? leaveError.message : String(leaveError));
    }
  };

  return (
    <Sheet title={exercise?.name ?? 'Challenge'} onClose={onClose}>
      {exercise && 'description' in exercise && exercise.description ? <p class="muted">{exercise.description as string}</p> : null}
      <p class="muted small">
        {board.memberCount} {board.memberCount === 1 ? 'person' : 'people'} · {formatWindow(board.challenge)}
      </p>
      <GroupProgress groupTotal={board.groupTotal} challenge={board.challenge} exercise={exercise} />
      <div class="seg seg--full" role="tablist" aria-label="Rank by">
        {CHALLENGE_METRICS.map((option) => (
          <button key={option} type="button" role="tab" class={metric === option ? 'is-on' : ''} aria-selected={metric === option} onClick={() => setMetric(option)}>
            {METRIC_LABELS[option]}
          </button>
        ))}
      </div>
      <BoardRows rows={rows} metric={metric} exercise={exercise} myId={tracker.account?.id} onOpen={(row) => friendIds.has(row.id) || row.id === tracker.account?.id ? onOpenProfile(row.id) : undefined} />

      <h3 class="sheet__subhead">Your link to it</h3>
      {url ? (
        <>
          <QrCode text={url} label="QR code of your challenge link" />
          <div class="field">
            <div class="token-row">
              <input type="text" readOnly aria-label="Your challenge link" value={url} onFocus={(event) => (event.target as HTMLInputElement).select()} />
              <button type="button" class="btn-text" onClick={() => void shareUrl(url).then(setNote)}>
                {'share' in navigator ? 'Share' : 'Copy'}
              </button>
            </div>
          </div>
          <p class="muted small">Whoever opens it joins, and becomes your friend. It stops working a week after the challenge ends.</p>
        </>
      ) : (
        <p class="muted small">Loading…</p>
      )}
      {note ? <p class="muted small">{note}</p> : null}
      <div class="sheet__actions sheet__actions--inline">
        {isConfirmingLeave ? (
          <>
            <button type="button" class="btn btn--danger" onClick={() => void leave()}>
              Leave challenge
            </button>
            <button type="button" class="btn" onClick={() => setIsConfirmingLeave(false)}>
              Stay
            </button>
          </>
        ) : (
          <button type="button" class="btn-text btn-text--quiet" onClick={() => setIsConfirmingLeave(true)}>
            Leave…
          </button>
        )}
      </div>
    </Sheet>
  );
}
