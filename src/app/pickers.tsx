import { useMemo, useState } from 'preact/hooks';
import { type Measure, allBuiltInExercises, allBuiltInVariations, builtInExercise, builtInVariation, isCreatedExerciseId } from '../shared/catalog';
import { MAX_DEFINITION_NAME_LENGTH, MAX_DESCRIPTION_LENGTH, MAX_UNIT_LENGTH, isVariationDefinition } from '../shared/definitions';
import { cleanName } from '../shared/model';
import { recentExerciseIds, toggleVariation } from '../shared/pad';
import { searchNames } from '../shared/names';
import { haptic } from './hooks';
import { Sheet } from './sheets';
import type { Tracker } from './tracker';

export interface KnownExercise {
  id: string;
  name: string;
  measure: Measure;
  unit?: string;
}

/** Every exercise this device can log to: the ones you've made or adopted, then the built-ins. */
export function knownExercises(tracker: Tracker): KnownExercise[] {
  const created = tracker
    .allDefinitions()
    .filter((definition) => !isVariationDefinition(definition))
    .map((definition) => definition as KnownExercise)
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...created.map(({ id, name, measure, unit }) => ({ id, name, measure, unit })), ...allBuiltInExercises().map(({ id, name, measure, unit }) => ({ id, name, measure, unit }))];
}

export interface KnownVariation {
  id: string;
  name: string;
}

/** Variations that fit an exercise: built-ins from its groups (all of them for a created exercise), then ones made for it. */
export function knownVariations(tracker: Tracker, exerciseId: string): KnownVariation[] {
  const groups = builtInExercise(exerciseId)?.variationGroups;
  const builtIns = allBuiltInVariations().filter((variation) => !groups || groups.includes(variation.group));
  const created = tracker
    .allDefinitions()
    .filter((definition) => isVariationDefinition(definition) && definition.exerciseId === exerciseId)
    .map(({ id, name }) => ({ id, name }));
  return [...created, ...builtIns.map(({ id, name }) => ({ id, name }))];
}

const UNIT_SUGGESTIONS = ['rep', 'lap', 'flight', 'step', 'meter', 'round'];

/** Picks an exercise, searching yours and the built-ins before offering to make a new one. */
export function ExercisePickerSheet({ tracker, onPick, onClose }: { tracker: Tracker; onPick: (exerciseId: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const exercises = useMemo(() => knownExercises(tracker), [tracker]);
  const recent = useMemo(() => recentExerciseIds(tracker.allEntries(), 8), [tracker]);
  const matches = query.trim() ? searchNames(query, exercises) : null;

  if (isCreating) return <NewExerciseForm tracker={tracker} initialName={query} onCreated={onPick} onCancel={() => setIsCreating(false)} onClose={onClose} />;

  const recentExercises = recent.map((exerciseId) => exercises.find((exercise) => exercise.id === exerciseId)).filter((exercise): exercise is KnownExercise => !!exercise);
  const yours = exercises.filter((exercise) => isCreatedExerciseId(exercise.id));
  const builtIns = exercises.filter((exercise) => !isCreatedExerciseId(exercise.id));

  return (
    <Sheet title="Exercise" onClose={onClose}>
      <label class="field">
        <span>Search</span>
        <input type="search" autocomplete="off" value={query} onInput={(event) => setQuery((event.target as HTMLInputElement).value)} placeholder="Pull-up, stairs, anything…" />
      </label>
      {matches ? (
        <ExerciseList exercises={matches} onPick={onPick} empty="Nothing by that name yet." />
      ) : (
        <>
          {recentExercises.length ? <ExerciseList title="Recent" exercises={recentExercises} onPick={onPick} /> : null}
          {yours.length ? <ExerciseList title="Yours" exercises={yours} onPick={onPick} /> : null}
          <ExerciseList title="Built in" exercises={builtIns} onPick={onPick} />
        </>
      )}
      <div class="sheet__actions">
        <button type="button" class="btn" onClick={() => setIsCreating(true)}>
          + New exercise{query.trim() ? `: ${query.trim()}` : ''}
        </button>
      </div>
    </Sheet>
  );
}

function ExerciseList({ title, exercises, onPick, empty }: { title?: string; exercises: KnownExercise[]; onPick: (exerciseId: string) => void; empty?: string }) {
  return (
    <>
      {title ? <h3 class="sheet__subhead">{title}</h3> : null}
      {exercises.length === 0 && empty ? <p class="muted small">{empty}</p> : null}
      <ul class="picker-list">
        {exercises.map((exercise) => (
          <li key={exercise.id}>
            <button type="button" class="picker-list__row" onClick={() => onPick(exercise.id)}>
              <span>{exercise.name}</span>
              <span class="muted small">{exercise.measure === 'time' ? 'timed' : exercise.unit === 'rep' ? '' : `${exercise.unit}s`}</span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

function NewExerciseForm({ tracker, initialName, onCreated, onCancel, onClose }: { tracker: Tracker; initialName: string; onCreated: (exerciseId: string) => void; onCancel: () => void; onClose: () => void }) {
  const [name, setName] = useState(initialName.trim());
  const [measure, setMeasure] = useState<Measure>('count');
  const [unit, setUnit] = useState('rep');
  const [description, setDescription] = useState('');
  const cleanedName = cleanName(name, MAX_DEFINITION_NAME_LENGTH);
  const cleanedUnit = cleanName(unit.toLowerCase(), MAX_UNIT_LENGTH);
  const cleanedDescription = description.trim() ? cleanName(description, MAX_DESCRIPTION_LENGTH) : '';
  const existing = useMemo(() => (cleanedName ? searchNames(cleanedName, knownExercises(tracker)).slice(0, 3) : []), [tracker, cleanedName]);
  const isValid = !!cleanedName && (measure === 'time' || !!cleanedUnit) && cleanedDescription !== null;

  const create = () => {
    if (!isValid) return;
    haptic(15);
    const exercise = tracker.createExercise({ name: cleanedName!, measure, unit: measure === 'count' ? cleanedUnit! : undefined, description: cleanedDescription || undefined });
    onCreated(exercise.id);
  };

  return (
    <Sheet title="New exercise" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          create();
        }}
      >
        <label class="field">
          <span>Name</span>
          <input type="text" maxLength={MAX_DEFINITION_NAME_LENGTH} value={name} onInput={(event) => setName((event.target as HTMLInputElement).value)} />
        </label>
        {existing.length ? (
          <p class="muted small">
            Already here:{' '}
            {existing.map((exercise, i) => (
              <span key={exercise.id}>
                {i ? ', ' : ''}
                <button type="button" class="btn-text" onClick={() => onCreated(exercise.id)}>
                  {exercise.name}
                </button>
              </span>
            ))}
          </p>
        ) : null}
        <div class="seg seg--wide" role="radiogroup" aria-label="Measured by">
          <button type="button" role="radio" aria-checked={measure === 'count'} class={measure === 'count' ? 'is-on' : ''} onClick={() => setMeasure('count')}>
            Counted
          </button>
          <button type="button" role="radio" aria-checked={measure === 'time'} class={measure === 'time' ? 'is-on' : ''} onClick={() => setMeasure('time')}>
            Timed
          </button>
        </div>
        {measure === 'count' ? (
          <>
            <label class="field">
              <span>One count is a…</span>
              <input type="text" maxLength={MAX_UNIT_LENGTH} autocapitalize="off" value={unit} onInput={(event) => setUnit((event.target as HTMLInputElement).value)} />
            </label>
            <div class="chips" role="group" aria-label="Common units">
              {UNIT_SUGGESTIONS.map((suggestion) => (
                <button key={suggestion} type="button" class={`chip${cleanedUnit === suggestion ? ' is-on' : ''}`} onClick={() => setUnit(suggestion)}>
                  {suggestion}
                </button>
              ))}
            </div>
            <p class="muted small">Only reps count toward the ring; laps, steps and the rest show on their own.</p>
          </>
        ) : null}
        <label class="field">
          <span>Description (optional)</span>
          <input type="text" maxLength={MAX_DESCRIPTION_LENGTH} value={description} onInput={(event) => setDescription((event.target as HTMLInputElement).value)} placeholder="What counts as one?" />
        </label>
        <p class="muted small">The unit and whether it's timed can't change later. Friends who see it can add it to theirs.</p>
        <div class="sheet__actions sheet__actions--inline">
          <button type="button" class="btn" onClick={onCancel}>
            Back
          </button>
          <button type="submit" class="btn btn--primary" disabled={!isValid}>
            Create
          </button>
        </div>
      </form>
    </Sheet>
  );
}

/** Turns an exercise's variations on and off, or makes a new one for it. */
export function VariationSheet({ tracker, exerciseId, variationIds, onChange, onClose }: { tracker: Tracker; exerciseId: string; variationIds: string[]; onChange: (variationIds: string[]) => void; onClose: () => void }) {
  const [name, setName] = useState('');
  const variations = knownVariations(tracker, exerciseId);
  const cleanedName = cleanName(name, MAX_DEFINITION_NAME_LENGTH);
  const existing = cleanedName ? searchNames(cleanedName, variations) : [];

  const create = () => {
    if (!cleanedName) return;
    const match = existing.find((variation) => variation.name.toLowerCase() === cleanedName.toLowerCase());
    const variationId = match?.id ?? tracker.createVariation(exerciseId, cleanedName).id;
    if (!variationIds.includes(variationId)) onChange(toggleVariation(variationIds, variationId));
    setName('');
  };

  return (
    <Sheet title="Configuration" onClose={onClose}>
      <div class="chips" role="group" aria-label="Variations">
        {variations.map((variation) => (
          <button key={variation.id} type="button" class={`chip${variationIds.includes(variation.id) ? ' is-on' : ''}`} aria-pressed={variationIds.includes(variation.id)} onClick={() => onChange(toggleVariation(variationIds, variation.id))}>
            {variation.name}
          </button>
        ))}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          create();
        }}
      >
        <label class="field">
          <span>New configuration</span>
          <div class="token-row">
            <input type="text" maxLength={MAX_DEFINITION_NAME_LENGTH} value={name} placeholder="Into tuck, ring turnout…" onInput={(event) => setName((event.target as HTMLInputElement).value)} />
            <button type="submit" class="btn-text" disabled={!cleanedName}>
              Add
            </button>
          </div>
        </label>
      </form>
      <p class="muted small">Built-in grips, tempos and progressions are one of each at a time.</p>
      <div class="sheet__actions">
        <button type="button" class="btn btn--primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Sheet>
  );
}

export function variationLabel(tracker: Tracker, exerciseId: string, variationId: string): string {
  return builtInVariation(variationId)?.name ?? tracker.variationName(exerciseId, variationId) ?? 'Unknown';
}
