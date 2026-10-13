import { describe, expect, it } from 'vitest';
import type { Entry } from '../src/shared/model';
import { SESSION_GAP_MS, lastContextFor, lastSet, padCounts, padHoldSeconds, recentExerciseIds, recentVariationIds, repeatableSessions, sessionsOf, templateOf, toggleVariation, usualAmount } from '../src/shared/pad';

const ZONE = 'America/Denver';
const at = (iso: string) => Date.parse(iso);
let nextId = 0;
const set = (doneAt: string, fields: Partial<Entry> = {}): Entry => ({ id: `e${++nextId}`, doneAt: at(doneAt), updatedAt: at(doneAt), reps: 5, ...fields }) as Entry;

describe('recent exercises and variations', () => {
  const history = [
    set('2026-10-08T09:00:00-06:00'),
    set('2026-10-08T09:05:00-06:00', { exerciseId: 'push-up', variationIds: ['archer'] }),
    set('2026-10-08T09:10:00-06:00', { variationIds: ['wide-grip'] }),
    set('2026-10-08T09:15:00-06:00', { variationIds: ['negative', 'wide-grip'] }),
    set('2026-10-08T09:20:00-06:00', { exerciseId: 'dip', deleted: true }),
  ];

  it('lists exercises newest first, skipping deleted sets', () => {
    expect(recentExerciseIds(history, 5)).toEqual(['pull-up', 'push-up']);
  });

  it("lists an exercise's variations newest first", () => {
    expect(recentVariationIds(history, 'pull-up', 5)).toEqual(['negative', 'wide-grip']);
    expect(recentVariationIds(history, 'push-up', 5)).toEqual(['archer']);
  });

  it('prefills the configuration of the last set of that exercise', () => {
    expect(lastContextFor(history, 'pull-up')).toEqual({ exerciseId: 'pull-up', variationIds: ['negative', 'wide-grip'] });
    expect(lastContextFor(history, 'squat')).toEqual({ exerciseId: 'squat', variationIds: [] });
  });

  it('repeats the most recently done live set', () => {
    expect(templateOf(lastSet(history)!)).toEqual({ exerciseId: 'pull-up', variationIds: ['negative', 'wide-grip'], reps: 5 });
    expect(lastSet([])).toBeNull();
  });
});

describe('toggleVariation', () => {
  it('keeps built-ins to one per group, and the list sorted', () => {
    expect(toggleVariation(['wide-grip'], 'close-grip')).toEqual(['close-grip']);
    expect(toggleVariation(['wide-grip'], 'negative')).toEqual(['negative', 'wide-grip']);
    expect(toggleVariation(['negative', 'wide-grip'], 'wide-grip')).toEqual(['negative']);
  });

  it('lets created variations sit beside anything', () => {
    expect(toggleVariation(['tuck', 'v-aaaaaaaaaaaaaaaa'], 'v-bbbbbbbbbbbbbbbb')).toEqual(['tuck', 'v-aaaaaaaaaaaaaaaa', 'v-bbbbbbbbbbbbbbbb']);
  });
});

describe('usualAmount and the pad', () => {
  const now = at('2026-10-08T12:00:00-06:00');
  const history = [
    set('2026-10-01T09:00:00-06:00', { reps: 8 }),
    set('2026-10-02T09:00:00-06:00', { reps: 8 }),
    set('2026-10-03T09:00:00-06:00', { reps: 6, variationIds: ['wide-grip'] }),
    set('2026-08-01T09:00:00-06:00', { reps: 12, variationIds: ['wide-grip'] }),
    set('2026-08-02T09:00:00-06:00', { reps: 12, variationIds: ['wide-grip'] }),
    set('2026-10-04T09:00:00-06:00', { exerciseId: 'plank', reps: undefined, holdSeconds: 40 }),
  ];

  it('reads the exact configuration over the last 30 days', () => {
    expect(usualAmount(history, { exerciseId: 'pull-up', variationIds: ['wide-grip'] }, now, ZONE)).toBe(6);
  });

  it('falls back to the exercise in any configuration, then null', () => {
    expect(usualAmount(history, { exerciseId: 'pull-up', variationIds: ['negative'] }, now, ZONE)).toBe(8);
    expect(usualAmount(history, { exerciseId: 'squat', variationIds: [] }, now, ZONE)).toBeNull();
  });

  it('reads holds in seconds', () => {
    expect(usualAmount(history, { exerciseId: 'plank', variationIds: [] }, now, ZONE)).toBe(40);
  });

  it('centres six counts on the usual', () => {
    expect(padCounts(5, 'rep')).toEqual([3, 4, 5, 6, 7, 8]);
    expect(padCounts(1, 'lap')).toEqual([1, 2, 3, 4, 5, 6]);
    expect(padCounts(null, 'rep')).toEqual([3, 4, 5, 6, 7, 8]);
    expect(padCounts(null, 'flight')).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('picks six durations around the usual hold, including an off-step usual', () => {
    expect(padHoldSeconds(null)).toEqual([10, 15, 20, 30, 45, 60]);
    expect(padHoldSeconds(60)).toEqual([30, 45, 60, 90, 120, 180]);
    expect(padHoldSeconds(40)).toEqual([20, 30, 40, 60, 90, 120]);
    expect(padHoldSeconds(5)).toEqual([5, 10, 15, 20, 30, 45]);
    expect(padHoldSeconds(3600)).toEqual([300, 600, 900, 1200, 1800, 3600]);
  });
});

describe('sessions', () => {
  const history = [
    set('2026-10-06T07:00:00-06:00'),
    set('2026-10-06T07:30:00-06:00', { exerciseId: 'dip' }),
    set('2026-10-06T08:59:00-06:00'),
    set('2026-10-06T18:00:00-06:00'),
    set('2026-10-07T07:00:00-06:00', { deleted: true }),
    set('2026-10-08T07:00:00-06:00'),
    set('2026-10-08T07:05:00-06:00'),
  ];

  it('splits on a gap of 90 minutes or more, newest first, sets oldest first', () => {
    const sessions = sessionsOf(history);
    expect(sessions.map((session) => session.entries.length)).toEqual([2, 1, 3]);
    expect(sessions[2]!.entries.map((entry) => entry.exerciseId ?? 'pull-up')).toEqual(['pull-up', 'dip', 'pull-up']);
    expect(sessions[2]!.endMs - sessions[2]!.startMs).toBeLessThan(2 * SESSION_GAP_MS);
  });

  it('offers only finished sessions of more than one set', () => {
    expect(repeatableSessions(history, at('2026-10-08T07:30:00-06:00'), 5).map((session) => session.startMs)).toEqual([at('2026-10-06T07:00:00-06:00')]);
    expect(repeatableSessions(history, at('2026-10-08T09:00:00-06:00'), 5)).toHaveLength(2);
  });
});
