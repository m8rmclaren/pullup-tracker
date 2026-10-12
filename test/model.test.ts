import { describe, expect, it } from 'vitest';
import { type Entry, clampAddedWeight, isValidEntry, mergeInto, mergeLists, normalizeEntry, pickWinner } from '../src/shared/model';
import { type Definition, isValidDefinition, mergeDefinitionsInto, pickDefinitionWinner } from '../src/shared/definitions';
import { loadFixture } from './fixtures';

interface MergeFixture {
  winners: { name: string; a: Entry; b: Entry; winner: 'a' | 'b' }[];
  replicas: { name: string; replicas: Entry[][]; merged: Entry[] }[];
  normalize: { name: string; entry: Entry; normalized: Entry }[];
  definitionWinners: { name: string; a: Definition; b: Definition; winner: 'a' | 'b' }[];
}

interface ValidationFixture {
  entries: { name: string; entry: unknown; valid: boolean }[];
  definitions: { name: string; definition: unknown; valid: boolean }[];
}

const mergeFixture = loadFixture<MergeFixture>('merge.json');
const validationFixture = loadFixture<ValidationFixture>('validation.json');

function merged(lists: Entry[][]): Entry[] {
  const entriesById = new Map<string, Entry>();
  for (const list of lists) mergeInto(entriesById, list);
  return [...entriesById.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  return items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
}

describe('merge.json', () => {
  it.each(mergeFixture.winners)('pickWinner: $name', ({ a, b, winner }) => {
    const expected = winner === 'a' ? a : b;
    expect(pickWinner(a, b)).toBe(expected);
    expect(pickWinner(b, a)).toBe(expected);
  });

  it.each(mergeFixture.replicas)('converges in every order: $name', ({ replicas, merged: expected }) => {
    for (const order of permutations(replicas)) expect(merged(order)).toEqual(expected);
    expect(merged([...replicas, ...replicas])).toEqual(expected);
  });

  it.each(mergeFixture.normalize)('normalizeEntry: $name', ({ entry, normalized }) => {
    expect(normalizeEntry(entry)).toEqual(normalized);
  });

  it.each(mergeFixture.definitionWinners)('pickDefinitionWinner: $name', ({ a, b, winner }) => {
    const expected = winner === 'a' ? a : b;
    expect(pickDefinitionWinner(a, b)).toBe(expected);
    expect(pickDefinitionWinner(b, a)).toBe(expected);
  });
});

describe('validation.json', () => {
  it.each(validationFixture.entries)('isValidEntry: $name → $valid', ({ entry, valid }) => {
    expect(isValidEntry(entry)).toBe(valid);
  });

  it.each(validationFixture.definitions)('isValidDefinition: $name → $valid', ({ definition, valid }) => {
    expect(isValidDefinition(definition)).toBe(valid);
  });
});

describe('mergeLists', () => {
  const entry = (id: string, updatedAt: number, extra: Partial<Entry> = {}): Entry => ({ id, doneAt: 1_000, reps: 5, updatedAt, ...extra });

  it('reports whether anything changed', () => {
    expect(mergeLists([entry('a', 1)], [entry('a', 1)]).changed).toBe(false);
    expect(mergeLists([entry('a', 2)], [entry('a', 1)]).changed).toBe(false);
    expect(mergeLists([entry('a', 1)], [entry('a', 2)]).changed).toBe(true);
    expect(mergeLists([entry('a', 1, { addedWeightLbs: 25 })], [entry('a', 1, { addedWeightLbs: 25 })]).changed).toBe(false);
  });
});

describe('mergeDefinitionsInto', () => {
  it('keeps the newer edit, and learns the creator from the server’s copy of the same version', () => {
    const local: Definition = { id: 'x-k3p7abcdefgh2345', name: 'Stairs', measure: 'count', unit: 'lap', createdAt: 1, updatedAt: 2 };
    const definitions = new Map<string, Definition>();
    expect(mergeDefinitionsInto(definitions, [local])).toEqual([local.id]);
    expect(mergeDefinitionsInto(definitions, [{ ...local, name: 'Old', updatedAt: 1 }])).toEqual([]);
    expect(mergeDefinitionsInto(definitions, [{ ...local, createdBy: 'u1' }])).toEqual([local.id]);
    expect(definitions.get(local.id)).toEqual({ ...local, createdBy: 'u1' });
    expect(mergeDefinitionsInto(definitions, [{ ...local, createdBy: 'u1' }])).toEqual([]);
  });
});

describe('clampAddedWeight', () => {
  it('rounds to the step and bounds the range', () => {
    expect(clampAddedWeight(22.6)).toBe(22.5);
    expect(clampAddedWeight(-3)).toBe(0);
    expect(clampAddedWeight(999)).toBe(300);
    expect(clampAddedWeight(Number.NaN)).toBe(0);
  });
});
