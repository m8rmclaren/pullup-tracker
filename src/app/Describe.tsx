import { useState } from 'preact/hooks';
import { type DraftItem, type ResolvedDraft, MAX_COMPOSE_TEXT_LENGTH, resolveDraft } from '../shared/compose';
import { MAX_DEFINITION_NAME_LENGTH, MAX_DESCRIPTION_LENGTH, MAX_UNIT_LENGTH, isVariationDefinition } from '../shared/definitions';
import { MAX_HOLD_SECONDS, MAX_REPS, MAX_VARIATIONS, cleanName, formatAddedWeight } from '../shared/model';
import { formatClock } from '../shared/time';
import { composeDraft } from './api';
import { haptic } from './hooks';
import { formatHoldSeconds } from './labels';
import { knownExercises, variationLabel } from './pickers';
import { Sheet } from './sheets';
import type { Tracker } from './tracker';

/**
 * Describe what you did; the composer drafts it as sets. The draft is the safety net: every set
 * shows, editable, and nothing is logged until Log all.
 */
export function DescribeSheet({ tracker, onClose, onLoggedAll }: { tracker: Tracker; onClose: () => void; onLoggedAll: (setCount: number) => void }) {
  const [text, setText] = useState('');
  const [draft, setDraft] = useState<ResolvedDraft | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const token = tracker.settings.token;
  const timeZone = tracker.timeZone();

  const submit = async () => {
    setIsBusy(true);
    setNote(null);
    try {
      const known = knownExercises(tracker);
      const nowMs = Date.now();
      const response = await composeDraft({ text: text.trim(), nowMs, timeZone, knownExercises: known }, token);
      if (!response.draft || !response.draft.sets.length) {
        setNote("Couldn't read that as sets. Try naming the exercise and the count, or use the pad.");
      } else {
        const variationsOf = (exerciseId: string) => tracker.allDefinitions().filter((definition) => isVariationDefinition(definition) && definition.exerciseId === exerciseId);
        setDraft(resolveDraft(response.draft, known, variationsOf, nowMs));
      }
    } catch (error) {
      setNote(`Couldn't read that: ${error instanceof Error ? error.message : String(error)}`);
    }
    setIsBusy(false);
  };

  const updateItem = (index: number, item: DraftItem | null) => {
    if (!draft) return;
    const items = [...draft.items];
    if (item) items[index] = item;
    else items.splice(index, 1);
    setDraft({ ...draft, items });
  };

  const logAll = () => {
    if (!draft) return;
    haptic(15);
    const createdExerciseIds = new Map<number, string>();
    const createdVariationIds = new Map<string, string>();
    for (const item of draft.items) {
      let exerciseId = item.exerciseId;
      if (exerciseId === undefined) {
        const index = item.newExerciseIndex!;
        if (!createdExerciseIds.has(index)) {
          const proposal = draft.newExercises[index]!;
          const created = tracker.createExercise({
            name: cleanName(proposal.name, MAX_DEFINITION_NAME_LENGTH) ?? 'New exercise',
            measure: proposal.measure,
            unit: proposal.measure === 'count' ? (cleanName(proposal.unit?.toLowerCase(), MAX_UNIT_LENGTH) ?? 'rep') : undefined,
            description: proposal.description ? (cleanName(proposal.description, MAX_DESCRIPTION_LENGTH) ?? undefined) : undefined,
          });
          createdExerciseIds.set(index, created.id);
        }
        exerciseId = createdExerciseIds.get(index)!;
      }
      const variationIds = [...item.variationIds];
      for (const name of item.newVariations) {
        const cleaned = cleanName(name, MAX_DEFINITION_NAME_LENGTH);
        if (!cleaned) continue;
        const key = `${exerciseId}/${cleaned.toLowerCase()}`;
        if (!createdVariationIds.has(key)) createdVariationIds.set(key, tracker.createVariation(exerciseId, cleaned).id);
        variationIds.push(createdVariationIds.get(key)!);
      }
      tracker.log({ exerciseId, variationIds: [...new Set(variationIds)].slice(0, MAX_VARIATIONS), reps: item.reps, holdSeconds: item.holdSeconds, addedWeightLbs: item.addedWeightLbs, doneAt: item.doneAt });
    }
    onLoggedAll(draft.items.length);
  };

  if (!token) {
    return (
      <Sheet title="Describe it" onClose={onClose}>
        <p class="muted">Describe needs an account, since the drafting happens on the server. Sign in under Settings; the pad works either way.</p>
      </Sheet>
    );
  }

  return (
    <Sheet title="Describe it" onClose={onClose}>
      {draft ? (
        <>
          <ul class="draft">
            {draft.items.map((item, index) => (
              <DraftCard key={index} tracker={tracker} draft={draft} item={item} timeZone={timeZone} onChange={(next) => updateItem(index, next)} />
            ))}
          </ul>
          {draft.newExercises.some((_, index) => draft.items.some((item) => item.newExerciseIndex === index)) ? <p class="muted small">New exercises are created when you log, and friends can add them to theirs.</p> : null}
          <div class="sheet__actions sheet__actions--inline">
            <button type="button" class="btn" onClick={() => setDraft(null)}>
              Back
            </button>
            <button type="button" class="btn btn--primary" disabled={!draft.items.length} onClick={logAll}>
              Log all {draft.items.length}
            </button>
          </div>
        </>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (text.trim() && !isBusy) void submit();
          }}
        >
          <label class="field">
            <span>What did you do?</span>
            <textarea rows={4} maxLength={MAX_COMPOSE_TEXT_LENGTH} value={text} placeholder="Ran the Red Rocks stairs 3 times, 20 push-ups at the top each time, then a 45 second tuck front lever" onInput={(event) => setText((event.target as HTMLTextAreaElement).value)} />
          </label>
          <p class="muted small">You'll see every set before anything is logged. Use the keyboard's microphone to say it instead. The text is sent to Claude to draft; your name isn't.</p>
          {note ? <p class="muted small">{note}</p> : null}
          <div class="sheet__actions">
            <button type="submit" class="btn btn--primary" disabled={!text.trim() || isBusy}>
              {isBusy ? 'Reading…' : 'Draft the sets'}
            </button>
          </div>
        </form>
      )}
    </Sheet>
  );
}

function DraftCard({ tracker, draft, item, timeZone, onChange }: { tracker: Tracker; draft: ResolvedDraft; item: DraftItem; timeZone: string; onChange: (item: DraftItem | null) => void }) {
  const proposal = item.newExerciseIndex !== undefined ? draft.newExercises[item.newExerciseIndex] : undefined;
  const exercise = item.exerciseId ? tracker.exercise(item.exerciseId) : proposal;
  const name = exercise?.name ?? 'Unknown exercise';
  const isTimed = item.holdSeconds !== undefined;
  const amount = item.holdSeconds ?? item.reps ?? 1;
  const unit = exercise && exercise.measure === 'count' ? (exercise.unit ?? 'rep') : undefined;
  const step = isTimed ? 5 : 1;
  const change = (delta: number) => {
    const next = Math.min(isTimed ? MAX_HOLD_SECONDS : MAX_REPS, Math.max(1, amount + delta));
    onChange(isTimed ? { ...item, holdSeconds: next } : { ...item, reps: next });
  };
  const configuration = [...item.variationIds.map((variationId) => variationLabel(tracker, item.exerciseId ?? '', variationId)), ...item.newVariations.map((variationName) => `${variationName} (new)`)].join(', ');

  return (
    <li class="draft__card">
      <div class="draft__main">
        <b>{name}</b>
        {proposal ? <span class="draft__new">New · {proposal.measure === 'time' ? 'timed' : `counted in ${proposal.unit ?? 'rep'}s`}</span> : null}
        {configuration ? <span class="muted small">{configuration}</span> : null}
        <span class="muted small">
          {formatClock(item.doneAt, timeZone)}
          {item.addedWeightLbs ? ` · ${formatAddedWeight(item.addedWeightLbs)}` : ''}
        </span>
      </div>
      <div class="stepper stepper--small" role="group" aria-label={`Amount for ${name}`}>
        <button type="button" class="stepper__btn" onClick={() => change(-step)} disabled={amount <= 1} aria-label="Decrease">
          −
        </button>
        <output class="stepper__val">{isTimed ? formatHoldSeconds(amount) : unit && unit !== 'rep' ? `${amount} ${amount === 1 ? unit : `${unit}s`}` : amount}</output>
        <button type="button" class="stepper__btn" onClick={() => change(step)} aria-label="Increase">
          +
        </button>
      </div>
      <button type="button" class="btn-text btn-text--quiet" aria-label={`Remove ${name}`} onClick={() => onChange(null)}>
        ×
      </button>
    </li>
  );
}
