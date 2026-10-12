import { type Measure, builtInExercise, isBuiltInId, isCreatedExerciseId, isCreatedVariationId } from './catalog';

// Exercises and variations anyone can create. Ids are made on the client, so a definition
// can be created offline and logged to at once; it travels in the sync push like an entry.
// Name and description are last-writer-wins on updatedAt; everything else is fixed at
// creation, because changing it would change the meaning of every set already logged.

export interface ExerciseDefinition {
  id: string;
  name: string;
  measure: Measure;
  /** What one count is ("lap", "rep"). Present exactly when measure is "count". */
  unit?: string;
  description?: string;
  /** Stamped by the server from the creator's account; absent until the first sync, and after the creator deletes their account. */
  createdBy?: string;
  createdAt: number;
  updatedAt: number;
}

/** Belongs to one exercise, built-in or created, and has no group. */
export interface VariationDefinition {
  id: string;
  exerciseId: string;
  name: string;
  createdBy?: string;
  createdAt: number;
  updatedAt: number;
}

export type Definition = ExerciseDefinition | VariationDefinition;

export const MAX_DEFINITION_NAME_LENGTH = 60;
export const MAX_UNIT_LENGTH = 20;
export const MAX_DESCRIPTION_LENGTH = 280;
export const MAX_PUSHED_DEFINITIONS = 100;

export const isVariationDefinition = (definition: Definition): definition is VariationDefinition => isCreatedVariationId(definition.id);

/** Where a definition is stored: its exercise, plus the variation for a variation. */
export interface DefinitionKey {
  exerciseId: string;
  variationId?: string;
}

export function definitionKeyOf(definition: Definition): DefinitionKey {
  return isVariationDefinition(definition) ? { exerciseId: definition.exerciseId, variationId: definition.id } : { exerciseId: definition.id };
}

/** One string per key, for maps and sets. A variation is only unique within its exercise, so both ids are in it. */
export const definitionKeyString = (key: DefinitionKey): string => (key.variationId ? `${key.exerciseId}/${key.variationId}` : key.exerciseId);

export function parseDefinitionKeyString(keyString: string): DefinitionKey {
  const [exerciseId, variationId] = keyString.split('/') as [string, string | undefined];
  return variationId ? { exerciseId, variationId } : { exerciseId };
}

const descriptionOf = (definition: Definition) => ('description' in definition ? (definition.description ?? '') : '');

/** Total order over versions of one definition, as pickWinner is for entries. */
export function pickDefinitionWinner<T extends Definition>(a: T, b: T): T {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b;
  if (a.name !== b.name) return a.name > b.name ? a : b;
  return descriptionOf(a) >= descriptionOf(b) ? a : b;
}

/** Same editable state; the fixed fields never differ between versions that are both accepted. */
export const sameDefinitionVersion = (a: Definition, b: Definition) => a.updatedAt === b.updatedAt && a.name === b.name && descriptionOf(a) === descriptionOf(b);

/** Merges into `into` (keyed by definitionKeyString) in place. Returns the keys whose stored version changed. */
export function mergeDefinitionsInto(into: Map<string, Definition>, incoming: Iterable<Definition>): string[] {
  const changed: string[] = [];
  for (const definition of incoming) {
    const keyString = definitionKeyString(definitionKeyOf(definition));
    const stored = into.get(keyString);
    if (!stored) {
      into.set(keyString, normalizeDefinition(definition));
      changed.push(keyString);
      continue;
    }
    const winner = pickDefinitionWinner(stored, definition);
    const next = sameDefinitionVersion(winner, stored) ? stored : winner;
    // A definition made on this device learns its creator from the server's copy.
    const createdBy = stored.createdBy ?? definition.createdBy;
    if (next === stored && stored.createdBy === createdBy) continue;
    into.set(keyString, normalizeDefinition({ ...next, createdBy }));
    changed.push(keyString);
  }
  return changed;
}

export function normalizeDefinition(definition: Definition): Definition {
  if (isVariationDefinition(definition)) {
    const variation: VariationDefinition = { id: definition.id, exerciseId: definition.exerciseId, name: definition.name, createdAt: definition.createdAt, updatedAt: definition.updatedAt };
    if (definition.createdBy) variation.createdBy = definition.createdBy;
    return variation;
  }
  const exercise: ExerciseDefinition = { id: definition.id, name: definition.name, measure: definition.measure, createdAt: definition.createdAt, updatedAt: definition.updatedAt };
  if (definition.unit) exercise.unit = definition.unit;
  if (definition.description) exercise.description = definition.description;
  if (definition.createdBy) exercise.createdBy = definition.createdBy;
  return exercise;
}

/** Printable, already trimmed, and 1 to `maxLength` characters. The server stores names at face value, so this is the whole check. */
export function isCleanText(value: unknown, maxLength: number): value is string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() || /[\p{Cc}\p{Cf}]/u.test(value)) return false;
  return [...value].length <= maxLength;
}

const isClock = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0;

/** Shape only. Whether the pusher may change it is the server's call. `createdBy` is ignored; the server stamps it. */
export function isValidDefinition(value: unknown): value is Definition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  if (typeof fields.id !== 'string' || !isClock(fields.createdAt) || !isClock(fields.updatedAt)) return false;
  if (!isCleanText(fields.name, MAX_DEFINITION_NAME_LENGTH)) return false;
  if (fields.createdBy !== undefined && typeof fields.createdBy !== 'string') return false;

  if (isCreatedVariationId(fields.id)) {
    const exerciseId = fields.exerciseId;
    return typeof exerciseId === 'string' && (isCreatedExerciseId(exerciseId) || (isBuiltInId(exerciseId) && builtInExercise(exerciseId) !== undefined));
  }
  if (!isCreatedExerciseId(fields.id)) return false;
  if (fields.measure === 'count') {
    if (!isCleanText(fields.unit, MAX_UNIT_LENGTH)) return false;
  } else if (fields.measure !== 'time' || fields.unit !== undefined) {
    return false;
  }
  return fields.description === undefined || isCleanText(fields.description, MAX_DESCRIPTION_LENGTH);
}
