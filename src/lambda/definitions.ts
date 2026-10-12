import { isCreatedExerciseId, isCreatedVariationId } from '../shared/catalog';
import { type Definition, type DefinitionKey, type ExerciseDefinition, definitionKeyOf, definitionKeyString, isVariationDefinition, normalizeDefinition, pickDefinitionWinner, sameDefinitionVersion } from '../shared/definitions';
import { type Entry, exerciseIdOf } from '../shared/model';
import { type Db, type StoredDefinition, PreconditionFailed } from './db';
import { type Clock, mapWithConcurrency } from './sync';

const MAX_ATTEMPTS = 8;

/** The created definitions an entry points at. */
export function definitionKeysOf(entry: Entry): DefinitionKey[] {
  const exerciseId = exerciseIdOf(entry);
  const keys: DefinitionKey[] = isCreatedExerciseId(exerciseId) ? [{ exerciseId }] : [];
  for (const variationId of entry.variationIds ?? []) if (isCreatedVariationId(variationId)) keys.push({ exerciseId, variationId });
  return keys;
}

function hasSameFixedFields(stored: Definition, incoming: Definition): boolean {
  if (isVariationDefinition(stored)) return isVariationDefinition(incoming) && stored.exerciseId === incoming.exerciseId;
  const incomingExercise = incoming as ExerciseDefinition;
  return stored.measure === incomingExercise.measure && (stored.unit ?? '') === (incomingExercise.unit ?? '');
}

/**
 * Creates or updates one pushed definition. The first push creates it, stamped with the
 * pusher as creator, and adopts it for them. After that only the creator can change it, and
 * only its name and description; anything else is dropped, not rejected, so a bad definition
 * can't wedge the rest of a client's outbox.
 */
async function mergePushedDefinition(db: Db, userId: string, incoming: Definition, clock: Clock): Promise<void> {
  const key = definitionKeyOf(incoming);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const stored = (await db.getDefinitions([key])).get(definitionKeyString(key));
    try {
      if (!stored) {
        await db.createDefinition({ ...normalizeDefinition({ ...incoming, createdBy: userId }), version: 1 }, userId, clock.now());
        return;
      }
      const winner = pickDefinitionWinner<Definition>(stored, incoming);
      if (sameDefinitionVersion(winner, stored)) return;
      if (stored.createdBy !== userId) {
        console.error(`ignoring a change to ${incoming.id} from ${userId}, who didn't create it`);
        return;
      }
      if (!hasSameFixedFields(stored, incoming)) {
        console.error(`ignoring a change to the fixed fields of ${incoming.id} from ${userId}`);
        return;
      }
      const edited = { ...stored, name: winner.name, updatedAt: winner.updatedAt };
      if (!isVariationDefinition(edited)) edited.description = (winner as ExerciseDefinition).description;
      await db.putDefinition({ ...normalizeDefinition(edited), version: stored.version + 1 }, stored.version);
      return;
    } catch (error) {
      if (!(error instanceof PreconditionFailed)) throw error;
    }
  }
  throw new Error(`gave up writing definition ${incoming.id} after ${MAX_ATTEMPTS} conflicting writes`);
}

export async function mergePushedDefinitions(db: Db, userId: string, pushedDefinitions: Definition[], clock: Clock): Promise<void> {
  // Variations after exercises, so a variation pushed with its new exercise lands second.
  const exercisesFirst = [...pushedDefinitions].sort((a, b) => Number(isVariationDefinition(a)) - Number(isVariationDefinition(b)));
  for (const definition of exercisesFirst) await mergePushedDefinition(db, userId, definition, clock);
}

/** The first pushed entry whose amount doesn't match its created exercise's measure, if any. Unknown exercises pass. */
export async function findMeasureMismatch(db: Db, pushedEntries: Entry[]): Promise<Entry | null> {
  const exerciseKeys = [...new Set(pushedEntries.map(exerciseIdOf).filter(isCreatedExerciseId))].map((exerciseId) => ({ exerciseId }));
  if (!exerciseKeys.length) return null;
  const definitions = await db.getDefinitions(exerciseKeys);
  for (const entry of pushedEntries) {
    const exercise = definitions.get(exerciseIdOf(entry)) as ExerciseDefinition | undefined;
    if (exercise && (exercise.measure === 'time') !== (entry.holdSeconds !== undefined)) return entry;
  }
  return null;
}

/**
 * Adopts the created definitions the pushed entries log to, then returns every definition the
 * client needs: all adopted ones (so renames reach every device) plus any the returned entries
 * point at.
 */
export async function definitionsForSync(db: Db, userId: string, pushedEntries: Entry[], returnedEntries: Entry[], clock: Clock): Promise<Definition[]> {
  const adoptedKeys = new Map((await db.adoptedDefinitionKeys(userId)).map((key) => [definitionKeyString(key), key]));
  const loggedKeys = new Map(pushedEntries.filter((entry) => !entry.deleted).flatMap(definitionKeysOf).map((key) => [definitionKeyString(key), key]));
  const unadoptedKeys = [...loggedKeys].filter(([keyString]) => !adoptedKeys.has(keyString)).map(([, key]) => key);
  if (unadoptedKeys.length) {
    const existing = await db.getDefinitions(unadoptedKeys);
    await mapWithConcurrency([...existing.values()], 8, (definition) => db.adoptDefinition(userId, definitionKeyOf(definition), clock.now()));
    for (const [keyString, definition] of existing) adoptedKeys.set(keyString, definitionKeyOf(definition));
  }

  const neededKeys = new Map(adoptedKeys);
  for (const key of returnedEntries.flatMap(definitionKeysOf)) neededKeys.set(definitionKeyString(key), key);
  const definitions = await db.getDefinitions([...neededKeys.values()]);
  return [...definitions.values()].map(({ version: _, ...definition }: StoredDefinition) => definition as Definition);
}
