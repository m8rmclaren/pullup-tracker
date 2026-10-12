import { describe, expect, it } from 'vitest';
import { hashToken } from '../src/lambda/auth';
import { MemoryDb } from '../src/lambda/db';
import { route } from '../src/lambda/http';
import { evaluateBoard } from '../src/shared/boards';
import type { Entry, LeaderboardResponse, ProfileViewResponse } from '../src/shared/model';

const NOW = Date.parse('2026-10-14T18:00:00Z');
const TOKENS = { op: 'operator-device-token-0123456789', ana: 'ana-device-token-0123456789ab', ben: 'ben-device-token-0123456789ab', eve: 'eve-device-token-0123456789ab' } as const;
type Person = keyof typeof TOKENS;
const STAIRS = { id: 'x-stairsaaaaaaaaaaa'.slice(0, 18), name: 'Red Rocks stairs', measure: 'count' as const, unit: 'lap', createdAt: 1, updatedAt: 1 };

/** The operator as production has them (no zone, no goal, a v1 day total), Ana and Ben their friends, Eve a stranger. */
async function setup() {
  const db = new MemoryDb();
  db.users.set('op', { id: 'op', name: 'Hayden', createdAt: 1 });
  db.users.set('ana', { id: 'ana', name: 'Ana', createdAt: 1, timeZone: 'Europe/London', dailyGoalReps: 30, goalUpdatedAt: 5, version: 1 });
  db.users.set('ben', { id: 'ben', name: 'Ben', createdAt: 1, timeZone: 'Pacific/Auckland' });
  db.users.set('eve', { id: 'eve', name: 'Eve', createdAt: 1 });
  for (const [id, token] of Object.entries(TOKENS)) db.tokens.set(hashToken(token), id);
  await db.befriend('op', 'ana', 1);
  await db.befriend('ben', 'op', 1);
  // As v1 wrote it: no holdSeconds, no byExercise.
  await db.putDayTotal('op', { day: '2026-10-13', reps: 41, sets: 7, bestSetReps: 8, version: 3 }, null);
  const post = (path: string, body: unknown = {}, as?: Person) => route({ method: 'POST', path, headers: as ? { 'x-pullup-token': TOKENS[as] } : {}, body: JSON.stringify(body) }, { db, clock: { now: () => NOW } });
  const log = async (as: Person, entries: Partial<Entry>[], pushedDefinitions: unknown[] = []) => {
    const pushedEntries = entries.map((entry, i) => ({ id: `${as}-${entry.doneAt}-${i}`, updatedAt: 1, ...entry }));
    expect((await post('/api/sync', { protocolVersion: 2, pushedEntries, pushedDefinitions, sinceCursor: 0 }, as)).status).toBe(200);
  };
  await log('ana', [{ doneAt: Date.parse('2026-10-14T09:00:00Z'), reps: 12 }, { doneAt: Date.parse('2026-10-12T09:00:00Z'), exerciseId: STAIRS.id, reps: 3 }], [STAIRS]);
  await log('ben', [{ doneAt: Date.parse('2026-10-14T20:00:00Z'), reps: 7 }]);
  await log('eve', [{ doneAt: Date.parse('2026-10-14T09:00:00Z'), reps: 99 }, { doneAt: Date.parse('2026-10-13T09:00:00Z'), exerciseId: 'x-evesecretaaaaaaa'.slice(0, 18), reps: 1 }], [{ ...STAIRS, id: 'x-evesecretaaaaaaa'.slice(0, 18), name: 'Eve only' }]);
  return { db, post };
}

describe('/api/leaderboard', () => {
  it('returns you and your friends, each with day totals in the window and nothing else', async () => {
    const { post } = await setup();
    const response = await post('/api/leaderboard', { fromDay: '2026-10-12', toDay: '2026-10-16' }, 'op');
    expect(response.status).toBe(200);
    const { users, definitions } = response.body as LeaderboardResponse;
    expect(users.map((user) => user.id).sort()).toEqual(['ana', 'ben', 'op']);
    const byId = new Map(users.map((user) => [user.id, user]));
    expect(byId.get('op')).toEqual({ id: 'op', name: 'Hayden', timeZone: 'America/Denver', days: [{ day: '2026-10-13', reps: 41, sets: 7, bestSetReps: 8 }] });
    expect(byId.get('ana')).toMatchObject({ name: 'Ana', timeZone: 'Europe/London', dailyGoalReps: 30 });
    expect(Object.keys(byId.get('ana')!).sort()).toEqual(['dailyGoalReps', 'days', 'id', 'name', 'timeZone']);
    expect(byId.get('ana')!.days.map((day) => day.day)).toEqual(['2026-10-12', '2026-10-14']);
    expect(byId.get('ben')!.days).toEqual([expect.objectContaining({ day: '2026-10-15', reps: 7 })]);
    expect(definitions).toEqual([expect.objectContaining({ id: STAIRS.id, name: 'Red Rocks stairs', createdBy: 'ana' })]);
    expect(JSON.stringify(response.body)).not.toContain('Eve');

    // What the client does with it: this week, by count, each in their own zone.
    expect(evaluateBoard({ metric: 'count', period: 'week' }, users, NOW).map((row) => [row.name, row.value])).toEqual([
      ['Hayden', 41],
      ['Ana', 12],
      ['Ben', 7],
    ]);
  });

  it('shows a stranger only themselves, and checks the window', async () => {
    const { post } = await setup();
    const strangers = (await post('/api/leaderboard', { fromDay: '2026-10-01', toDay: '2026-10-31' }, 'eve')).body as LeaderboardResponse;
    expect(strangers.users.map((user) => user.id)).toEqual(['eve']);
    expect((await post('/api/leaderboard', { fromDay: '2026-10-01', toDay: '2026-12-01' }, 'op')).status).toBe(200);
    expect((await post('/api/leaderboard', { fromDay: '2026-10-01', toDay: '2026-12-02' }, 'op')).status).toBe(400);
    expect((await post('/api/leaderboard', { fromDay: '2026-10-14', toDay: '2026-10-13' }, 'op')).status).toBe(400);
    expect((await post('/api/leaderboard', { fromDay: '2026-02-30', toDay: '2026-03-01' }, 'op')).status).toBe(400);
    expect((await post('/api/leaderboard', { fromDay: 'yesterday', toDay: '2026-10-13' }, 'op')).status).toBe(400);
    expect((await post('/api/leaderboard', { fromDay: '2026-10-01', toDay: '2026-10-31' })).status).toBe(401);
  });
});

describe('/api/profile/view', () => {
  it('shows a friend’s profile, recent days and every exercise with totals and bests', async () => {
    const { post } = await setup();
    const response = await post('/api/profile/view', { userId: 'ana' }, 'op');
    expect(response.status).toBe(200);
    const view = response.body as ProfileViewResponse;
    expect(view.profile).toEqual({ id: 'ana', name: 'Ana', timeZone: 'Europe/London', dailyGoalReps: 30 });
    expect(view.days.map((day) => day.day)).toEqual(['2026-10-12', '2026-10-14']);
    expect(view.exercises).toEqual([
      { exerciseId: 'pull-up', totals: { sets: 1, activeDays: 1, reps: 12 }, bests: { bestSetReps: 12 } },
      { exerciseId: STAIRS.id, totals: { sets: 1, activeDays: 1, reps: 3 }, bests: { bestSetReps: 3 } },
    ]);
    expect(view.definitions).toEqual([expect.objectContaining({ id: STAIRS.id })]);
  });

  it('reads the operator’s pre-v2 history, for a friend', async () => {
    const { post } = await setup();
    const view = (await post('/api/profile/view', { userId: 'op' }, 'ana')).body as ProfileViewResponse;
    expect(view.profile).toEqual({ id: 'op', name: 'Hayden', timeZone: 'America/Denver' });
    expect(view.exercises).toEqual([{ exerciseId: 'pull-up', totals: { sets: 7, activeDays: 1, reps: 41 }, bests: { bestSetReps: 8 } }]);
  });

  it('answers the same 404 for a stranger, a missing account and junk, and stops when the friendship does', async () => {
    const { post } = await setup();
    const stranger = await post('/api/profile/view', { userId: 'eve' }, 'op');
    const missing = await post('/api/profile/view', { userId: 'nobody' }, 'op');
    expect(stranger).toEqual({ status: 404, body: { error: 'not found' } });
    expect(missing).toEqual(stranger);
    expect(await post('/api/profile/view', {}, 'op')).toEqual(stranger);
    expect(await post('/api/profile/view', { userId: 'op' }, 'eve')).toEqual(stranger);
    expect((await post('/api/profile/view', { userId: 'eve' }, 'eve')).status).toBe(200);
    await post('/api/friends/remove', { friendId: 'op' }, 'ana');
    expect(await post('/api/profile/view', { userId: 'op' }, 'ana')).toEqual(stranger);
    expect((await post('/api/profile/view', { userId: 'ana' })).status).toBe(401);
  });
});
