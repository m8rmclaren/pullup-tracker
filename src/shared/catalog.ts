import catalog from './catalog.json';

export type Measure = 'count' | 'time';

export interface BuiltInExercise {
  id: string;
  name: string;
  measure: Measure;
  /** What one count is ("rep", "lap"); absent for timed exercises. */
  unit?: string;
  variationGroups: string[];
}

export interface BuiltInVariation {
  id: string;
  name: string;
  group: string;
}

export const PULL_UP = 'pull-up';
/** The unit whose counts go on the ring. */
export const RING_UNIT = 'rep';

const builtInExercises = new Map((catalog.exercises as BuiltInExercise[]).map((exercise) => [exercise.id, exercise]));
const builtInVariations = new Map((catalog.variations as BuiltInVariation[]).map((variation) => [variation.id, variation]));

export function builtInExercise(id: string): BuiltInExercise | undefined {
  return builtInExercises.get(id);
}

export function builtInVariation(id: string): BuiltInVariation | undefined {
  return builtInVariations.get(id);
}

export function allBuiltInExercises(): BuiltInExercise[] {
  return [...builtInExercises.values()];
}

// Created ids are random lowercase base32, and no built-in slug starts with "x-" or "v-", so
// the prefix alone says which kind an id is.
export const CREATED_EXERCISE_ID = /^x-[a-z2-7]{16}$/;
export const CREATED_VARIATION_ID = /^v-[a-z2-7]{16}$/;
const BUILT_IN_ID = /^[a-z0-9-]{1,40}$/;

export const isCreatedExerciseId = (id: string) => CREATED_EXERCISE_ID.test(id);
export const isCreatedVariationId = (id: string) => CREATED_VARIATION_ID.test(id);
export const isBuiltInId = (id: string) => BUILT_IN_ID.test(id) && !id.startsWith('x-') && !id.startsWith('v-');
