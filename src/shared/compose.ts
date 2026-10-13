import { type Measure, allBuiltInVariations } from './catalog';
import { MAX_DEFINITION_NAME_LENGTH, MAX_DESCRIPTION_LENGTH, MAX_UNIT_LENGTH } from './definitions';
import { MAX_ADDED_WEIGHT_LBS, MAX_HOLD_SECONDS, MAX_REPS, MAX_VARIATIONS, MIN_HOLD_SECONDS, MIN_REPS } from './model';
import { type NamedItem, matchName, nameKey } from './names';
import { toggleVariation } from './pad';
import { isValidTimeZone } from './time';

// The composer turns a sentence into a draft of sets for you to confirm; it never logs. The
// model only names things. Picking ids is this deterministic resolver, so it can be tested
// with fixtures (test/fixtures/compose/drafts.json) and the ids stay out of the model's reach.

/** One line of the model's draft. `repeat` expands into that many identical sets. */
export interface ComposedSet {
  exercise: string;
  variations: string[];
  reps?: number;
  holdSeconds?: number;
  addedWeightLbs?: number;
  repeat: number;
  /** How long before the request's `nowMs` the set was done: 0 for now, 1440 for this time yesterday. */
  minutesAgo: number;
}

/** An exercise the model didn't find among the known ones, described in the person's words. */
export interface ComposedExercise {
  name: string;
  measure: Measure;
  unit?: string;
  description?: string;
}

/** The model's output, the same shape whichever model produced it. */
export interface ComposedDraft {
  sets: ComposedSet[];
  newExercises: ComposedExercise[];
}

export interface KnownExercise {
  id: string;
  name: string;
  measure: Measure;
  unit?: string;
}

/** POST /api/compose. The known exercises are the ones the client can resolve to; only their names reach the model. */
export interface ComposeRequest {
  text: string;
  nowMs: number;
  timeZone: string;
  knownExercises: KnownExercise[];
}

/** `draft` is null when the text couldn't be read as sets. */
export interface ComposeResponse {
  draft: ComposedDraft | null;
}

export const MAX_COMPOSE_TEXT_LENGTH = 1000;
export const MAX_KNOWN_EXERCISES = 300;
export const MAX_DRAFT_LINES = 50;
export const MAX_DRAFT_SETS = 100;
export const MAX_NEW_EXERCISES = 10;
export const MAX_REPEAT = 50;
/** Relative times reach back a week; anything older belongs in the day editor. */
export const MAX_MINUTES_AGO = 7 * 24 * 60;
/** Sets expanded from one line are this far apart, so their order survives. */
export const DRAFT_SET_SPACING_MS = 1000;

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isIntegerBetween = (value: unknown, min: number, max: number) => Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
const isShortText = (value: unknown, maxLength: number) => typeof value === 'string' && value.trim().length > 0 && [...value].length <= maxLength;

export function isValidComposeRequest(value: unknown): value is ComposeRequest {
  if (!isObject(value)) return false;
  if (!isShortText(value.text, MAX_COMPOSE_TEXT_LENGTH)) return false;
  if (!Number.isSafeInteger(value.nowMs) || (value.nowMs as number) <= 0) return false;
  if (!isValidTimeZone(value.timeZone)) return false;
  const known = value.knownExercises;
  if (!Array.isArray(known) || known.length > MAX_KNOWN_EXERCISES) return false;
  return known.every((exercise) => isObject(exercise) && typeof exercise.id === 'string' && exercise.id.length <= 64 && isShortText(exercise.name, MAX_DEFINITION_NAME_LENGTH) && (exercise.measure === 'count' || exercise.measure === 'time') && (exercise.unit === undefined || isShortText(exercise.unit, MAX_UNIT_LENGTH)));
}

/** Checks a model's output before it leaves the server: the right shape, sane numbers, a bounded size. */
export function isValidDraft(value: unknown): value is ComposedDraft {
  if (!isObject(value) || !Array.isArray(value.sets) || !Array.isArray(value.newExercises)) return false;
  if (value.sets.length > MAX_DRAFT_LINES || value.newExercises.length > MAX_NEW_EXERCISES) return false;
  let setCount = 0;
  for (const set of value.sets) {
    if (!isObject(set) || !isShortText(set.exercise, MAX_DEFINITION_NAME_LENGTH)) return false;
    if (!Array.isArray(set.variations) || set.variations.length > MAX_VARIATIONS || !set.variations.every((variation) => isShortText(variation, MAX_DEFINITION_NAME_LENGTH))) return false;
    if ((set.reps === undefined) === (set.holdSeconds === undefined)) return false;
    if (set.reps !== undefined && !isIntegerBetween(set.reps, MIN_REPS, MAX_REPS)) return false;
    if (set.holdSeconds !== undefined && !isIntegerBetween(set.holdSeconds, MIN_HOLD_SECONDS, MAX_HOLD_SECONDS)) return false;
    if (set.addedWeightLbs !== undefined && !(typeof set.addedWeightLbs === 'number' && set.addedWeightLbs >= 0 && set.addedWeightLbs <= MAX_ADDED_WEIGHT_LBS)) return false;
    if (!isIntegerBetween(set.repeat, 1, MAX_REPEAT) || !isIntegerBetween(set.minutesAgo, 0, MAX_MINUTES_AGO)) return false;
    setCount += set.repeat as number;
  }
  if (setCount > MAX_DRAFT_SETS) return false;
  return value.newExercises.every(
    (exercise) =>
      isObject(exercise) &&
      isShortText(exercise.name, MAX_DEFINITION_NAME_LENGTH) &&
      (exercise.measure === 'count' ? isShortText(exercise.unit, MAX_UNIT_LENGTH) : exercise.measure === 'time' && exercise.unit === undefined) &&
      (exercise.description === undefined || (typeof exercise.description === 'string' && [...exercise.description].length <= MAX_DESCRIPTION_LENGTH)),
  );
}

/** A set ready to confirm. Its exercise is a known id or one of the draft's new exercises; likewise its variations. */
export interface DraftItem {
  exerciseId?: string;
  /** Index into ResolvedDraft.newExercises. */
  newExerciseIndex?: number;
  variationIds: string[];
  /** Variations not found for this exercise, by name, to create when logging. */
  newVariations: string[];
  reps?: number;
  holdSeconds?: number;
  addedWeightLbs?: number;
  doneAt: number;
}

export interface ResolvedDraft {
  items: DraftItem[];
  newExercises: ComposedExercise[];
}

/**
 * Resolves names to ids and expands repeats. An exercise name matches a known exercise
 * (matchName), else a new exercise in the draft by name, else becomes a new one, counted in
 * reps or timed by the set's amount. A proposed new exercise that matches a known one is
 * dropped in its favour. An amount in the wrong measure for a known exercise moves to the
 * right one (a timed exercise's "reps" are seconds). Sets of one line are a second apart, the
 * last at its line's time.
 */
export function resolveDraft(draft: ComposedDraft, known: KnownExercise[], variationsOf: (exerciseId: string) => NamedItem[], nowMs: number): ResolvedDraft {
  const newExercises: ComposedExercise[] = [];
  const newIndexByKey = new Map<string, number>();
  const addNew = (exercise: ComposedExercise) => {
    const key = nameKey(exercise.name);
    if (!newIndexByKey.has(key)) {
      newIndexByKey.set(key, newExercises.length);
      newExercises.push(exercise);
    }
    return newIndexByKey.get(key)!;
  };
  const proposed = new Map(draft.newExercises.map((exercise) => [nameKey(exercise.name), exercise]));

  const items: DraftItem[] = [];
  for (const set of draft.sets) {
    const match = matchName(set.exercise, known);
    let measure: Measure;
    const item: Omit<DraftItem, 'doneAt'> = { variationIds: [], newVariations: [] };
    if (match) {
      item.exerciseId = match.id;
      measure = match.measure;
    } else {
      const proposal = proposed.get(nameKey(set.exercise)) ?? { name: set.exercise, measure: set.holdSeconds !== undefined ? 'time' : 'count', unit: set.holdSeconds !== undefined ? undefined : 'rep' };
      item.newExerciseIndex = addNew(proposal);
      measure = proposal.measure;
    }

    const knownVariations = item.exerciseId ? [...variationsOf(item.exerciseId), ...allBuiltInVariations()] : allBuiltInVariations();
    for (const variationName of set.variations) {
      const variation = matchName(variationName, knownVariations);
      if (variation) item.variationIds = toggleVariation(item.variationIds, variation.id);
      else if (!item.newVariations.some((name) => nameKey(name) === nameKey(variationName))) item.newVariations.push(variationName);
    }

    const amount = set.reps ?? set.holdSeconds!;
    if (measure === 'time') item.holdSeconds = Math.min(MAX_HOLD_SECONDS, amount);
    else item.reps = amount;
    if (set.addedWeightLbs) item.addedWeightLbs = set.addedWeightLbs;

    const lastAtMs = nowMs - set.minutesAgo * 60_000;
    for (let i = 0; i < set.repeat; i++) items.push({ ...item, variationIds: [...item.variationIds], newVariations: [...item.newVariations], doneAt: lastAtMs - (set.repeat - 1 - i) * DRAFT_SET_SPACING_MS });
  }
  return { items, newExercises };
}
