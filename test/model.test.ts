import { describe, expect, it } from 'vitest';
import { type Entry, clampAddedWeight, isValidEntry, mergeInto, mergeLists, pickWinner } from '../src/shared/model';

const entry = (id: string, updatedAt: number, extra: Partial<Entry> = {}): Entry => ({ id, doneAt: 1_000, reps: 5, updatedAt, ...extra });

function merged(...lists: Entry[][]): Entry[] {
  const entriesById = new Map<string, Entry>();
  for (const list of lists) mergeInto(entriesById, list);
  return [...entriesById.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

describe('LWW merge', () => {
  it('newest version wins', () => {
    expect(pickWinner(entry('a', 1, { reps: 5 }), entry('a', 2, { reps: 7 })).reps).toBe(7);
  });

  it('delete wins a same-tick tie', () => {
    expect(pickWinner(entry('a', 5), entry('a', 5, { deleted: true })).deleted).toBe(true);
    expect(pickWinner(entry('a', 5, { deleted: true }), entry('a', 5)).deleted).toBe(true);
  });

  it('is commutative, associative and idempotent', () => {
    const replicaA = [entry('x', 1), entry('y', 3, { reps: 8 })];
    const replicaB = [entry('x', 2, { reps: 4 }), entry('z', 1)];
    const replicaC = [entry('y', 3, { deleted: true }), entry('x', 2, { reps: 6 })];
    const expected = merged(replicaA, replicaB, replicaC);
    expect(merged(replicaC, replicaB, replicaA)).toEqual(expected);
    expect(merged(replicaB, replicaA, replicaC, replicaA, replicaB)).toEqual(expected);
    expect(merged(merged(replicaA, replicaB), replicaC)).toEqual(merged(replicaA, merged(replicaB, replicaC)));
  });

  it('a stale copy of an entry edited into another month loses everywhere', () => {
    // Edit moved the set from Oct 31 to Nov 1; the Oct month doc still holds the old version.
    const octDoc = [entry('s', 1, { doneAt: Date.parse('2026-10-31T20:00:00Z') })];
    const novDoc = [entry('s', 2, { doneAt: Date.parse('2026-11-01T20:00:00Z') })];
    expect(merged(octDoc, novDoc)[0]!.doneAt).toBe(Date.parse('2026-11-01T20:00:00Z'));
    expect(merged(novDoc, octDoc)[0]!.doneAt).toBe(Date.parse('2026-11-01T20:00:00Z'));
  });

  it('carries added weight and treats a weight-only difference as a new version', () => {
    expect(merged([entry('a', 1)], [entry('a', 2, { addedWeightLbs: 25 })])[0]!.addedWeightLbs).toBe(25);
    expect(mergeLists([entry('a', 1, { addedWeightLbs: 25 })], [entry('a', 1, { addedWeightLbs: 25 })]).changed).toBe(false);
    // Same tick, different weight: both orders converge.
    expect(merged([entry('a', 3, { addedWeightLbs: 10 })], [entry('a', 3)])).toEqual(merged([entry('a', 3)], [entry('a', 3, { addedWeightLbs: 10 })]));
  });

  it('reports whether anything changed', () => {
    expect(mergeLists([entry('a', 1)], [entry('a', 1)]).changed).toBe(false);
    expect(mergeLists([entry('a', 2)], [entry('a', 1)]).changed).toBe(false);
    expect(mergeLists([entry('a', 1)], [entry('a', 2)]).changed).toBe(true);
  });
});

describe('isValidEntry', () => {
  it('rejects junk', () => {
    expect(isValidEntry(entry('ok_1', 1))).toBe(true);
    expect(isValidEntry({ ...entry('a', 1), reps: 0 })).toBe(false);
    expect(isValidEntry({ ...entry('a', 1), reps: 4.5 })).toBe(false);
    expect(isValidEntry({ ...entry('../x', 1) })).toBe(false);
    expect(isValidEntry({ ...entry('a', 1), deleted: 'yes' })).toBe(false);
    expect(isValidEntry(null)).toBe(false);
  });

  it('accepts added weight in half-pound steps up to the cap', () => {
    expect(isValidEntry(entry('a', 1, { addedWeightLbs: 22.5 }))).toBe(true);
    expect(isValidEntry(entry('a', 1, { addedWeightLbs: 0 }))).toBe(false);
    expect(isValidEntry(entry('a', 1, { addedWeightLbs: -5 }))).toBe(false);
    expect(isValidEntry(entry('a', 1, { addedWeightLbs: 2.25 }))).toBe(false);
    expect(isValidEntry(entry('a', 1, { addedWeightLbs: 301 }))).toBe(false);
    expect(isValidEntry({ ...entry('a', 1), addedWeightLbs: '25' })).toBe(false);
  });

  it('clampAddedWeight rounds to the step and bounds the range', () => {
    expect(clampAddedWeight(22.6)).toBe(22.5);
    expect(clampAddedWeight(-3)).toBe(0);
    expect(clampAddedWeight(999)).toBe(300);
    expect(clampAddedWeight(Number.NaN)).toBe(0);
  });
});
