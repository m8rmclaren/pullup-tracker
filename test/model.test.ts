import { describe, expect, it } from 'vitest';
import { type Entry, isValidEntry, mergeInto, mergeLists, pickWinner } from '../src/shared/model';

const e = (id: string, updatedAt: number, extra: Partial<Entry> = {}): Entry => ({ id, ts: 1_000, reps: 5, updatedAt, ...extra });

function merged(...lists: Entry[][]): Entry[] {
  const m = new Map<string, Entry>();
  for (const l of lists) mergeInto(m, l);
  return [...m.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

describe('LWW merge', () => {
  it('newest version wins', () => {
    expect(pickWinner(e('a', 1, { reps: 5 }), e('a', 2, { reps: 7 })).reps).toBe(7);
  });

  it('delete wins a same-tick tie', () => {
    expect(pickWinner(e('a', 5), e('a', 5, { deleted: true })).deleted).toBe(true);
    expect(pickWinner(e('a', 5, { deleted: true }), e('a', 5)).deleted).toBe(true);
  });

  it('is commutative, associative and idempotent', () => {
    const A = [e('x', 1), e('y', 3, { reps: 8 })];
    const B = [e('x', 2, { reps: 4 }), e('z', 1)];
    const C = [e('y', 3, { deleted: true }), e('x', 2, { reps: 6 })];
    const ref = merged(A, B, C);
    expect(merged(C, B, A)).toEqual(ref);
    expect(merged(B, A, C, A, B)).toEqual(ref);
    expect(merged(merged(A, B), C)).toEqual(merged(A, merged(B, C)));
  });

  it('a stale copy of an entry edited into another month loses everywhere', () => {
    // Edit moved the set from Oct 31 to Nov 1; the Oct month doc still holds the old version.
    const octDoc = [e('s', 1, { ts: Date.parse('2026-10-31T20:00:00Z') })];
    const novDoc = [e('s', 2, { ts: Date.parse('2026-11-01T20:00:00Z') })];
    expect(merged(octDoc, novDoc)[0]!.ts).toBe(Date.parse('2026-11-01T20:00:00Z'));
    expect(merged(novDoc, octDoc)[0]!.ts).toBe(Date.parse('2026-11-01T20:00:00Z'));
  });

  it('reports whether anything changed', () => {
    expect(mergeLists([e('a', 1)], [e('a', 1)]).changed).toBe(false);
    expect(mergeLists([e('a', 2)], [e('a', 1)]).changed).toBe(false);
    expect(mergeLists([e('a', 1)], [e('a', 2)]).changed).toBe(true);
  });
});

describe('isValidEntry', () => {
  it('rejects junk', () => {
    expect(isValidEntry(e('ok_1', 1))).toBe(true);
    expect(isValidEntry({ ...e('a', 1), reps: 0 })).toBe(false);
    expect(isValidEntry({ ...e('a', 1), reps: 4.5 })).toBe(false);
    expect(isValidEntry({ ...e('../x', 1) })).toBe(false);
    expect(isValidEntry({ ...e('a', 1), deleted: 'yes' })).toBe(false);
    expect(isValidEntry(null)).toBe(false);
  });
});
