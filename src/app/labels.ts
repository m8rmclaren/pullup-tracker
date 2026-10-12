import { PULL_UP, builtInExercise } from '../shared/catalog';
import { type Entry, exerciseIdOf, formatAddedWeight } from '../shared/model';

export function exerciseName(exerciseId: string): string {
  return builtInExercise(exerciseId)?.name ?? 'Unknown exercise';
}

/** "6", or "45s" for a hold. */
export function formatAmount(entry: Entry): string {
  return entry.holdSeconds !== undefined ? formatHoldSeconds(entry.holdSeconds) : String(entry.reps);
}

export function formatHoldSeconds(holdSeconds: number): string {
  if (holdSeconds < 60) return `${holdSeconds}s`;
  const minutes = Math.floor(holdSeconds / 60);
  const seconds = holdSeconds % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/** The exercise, for a set that isn't a plain pull-up; empty for a pull-up. */
export function exerciseLabel(entry: Entry): string {
  return exerciseIdOf(entry) === PULL_UP ? '' : exerciseName(exerciseIdOf(entry));
}

/** "6", "6 @ +25 lb", "45s Front lever". */
export function describeSet(entry: Entry): string {
  const weight = entry.addedWeightLbs ? ` @ ${formatAddedWeight(entry.addedWeightLbs)}` : '';
  const exercise = exerciseLabel(entry);
  return `${formatAmount(entry)}${weight}${exercise ? ` ${exercise}` : ''}`;
}
