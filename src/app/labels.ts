import { PULL_UP } from '../shared/catalog';
import { type Entry, exerciseIdOf, formatAddedWeight } from '../shared/model';
import type { UnitLookup } from '../shared/stats';
import type { Tracker } from './tracker';

export type ExerciseLookup = Pick<Tracker, 'exercise'>;

export function exerciseName(exerciseId: string, exercises: ExerciseLookup): string {
  return exercises.exercise(exerciseId)?.name ?? 'Unknown exercise';
}

/** The ring's unit lookup over built-in and created exercises. */
export const unitLookup =
  (exercises: ExerciseLookup): UnitLookup =>
  (exerciseId) =>
    exercises.exercise(exerciseId)?.unit;

/** "6", "3 laps", or "45s" for a hold. */
export function formatAmount(entry: Entry, exercises: ExerciseLookup): string {
  if (entry.holdSeconds !== undefined) return formatHoldSeconds(entry.holdSeconds);
  const unit = exercises.exercise(exerciseIdOf(entry))?.unit;
  return !unit || unit === 'rep' ? String(entry.reps) : `${entry.reps} ${entry.reps === 1 ? unit : `${unit}s`}`;
}

export function formatHoldSeconds(holdSeconds: number): string {
  if (holdSeconds < 60) return `${holdSeconds}s`;
  const minutes = Math.floor(holdSeconds / 60);
  const seconds = holdSeconds % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/** The exercise, for a set that isn't a plain pull-up; empty for a pull-up. */
export function exerciseLabel(entry: Entry, exercises: ExerciseLookup): string {
  return exerciseIdOf(entry) === PULL_UP ? '' : exerciseName(exerciseIdOf(entry), exercises);
}

/** "6", "6 @ +25 lb", "45s Front lever", "3 laps Red Rocks stairs". */
export function describeSet(entry: Entry, exercises: ExerciseLookup): string {
  const weight = entry.addedWeightLbs ? ` @ ${formatAddedWeight(entry.addedWeightLbs)}` : '';
  const exercise = exerciseLabel(entry, exercises);
  return `${formatAmount(entry, exercises)}${weight}${exercise ? ` ${exercise}` : ''}`;
}
