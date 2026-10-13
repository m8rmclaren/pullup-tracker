import { describe, expect, it, vi } from 'vitest';
import { hashToken } from '../src/lambda/auth';
import { MemoryDb } from '../src/lambda/db';
import { route } from '../src/lambda/http';
import type { Definition, ExerciseDefinition, VariationDefinition } from '../src/shared/definitions';
import type { Entry, SyncResponse } from '../src/shared/model';

const OCT8 = Date.parse('2026-10-08T18:00:00Z');
const AMA_TOKEN = 'device-token-for-ama-0123456789ab';
const BEN_TOKEN = 'device-token-for-ben-0123456789ab';
const STAIRS: ExerciseDefinition = { id: 'x-k3p7abcdefgh2345', name: 'Red Rocks stairs', measure: 'count', unit: 'lap', description: 'Bottom to top', createdAt: OCT8, updatedAt: OCT8 };
const INTO_TUCK: VariationDefinition = { id: 'v-6qzrabcdefgh2345', exerciseId: 'muscle-up', name: 'Into tuck', createdAt: OCT8, updatedAt: OCT8 };
let entryCount = 0;
const makeEntry = (extra: Partial<Entry> = {}): Entry => ({ id: `d${++entryCount}`, doneAt: OCT8, updatedAt: 1, reps: 3, ...extra });

function setup() {
  const db = new MemoryDb();
  db.users.set('ama', { id: 'ama', name: 'Ama', createdAt: 1 });
  db.users.set('ben', { id: 'ben', name: 'Ben', createdAt: 1 });
  db.tokens.set(hashToken(AMA_TOKEN), 'ama');
  db.tokens.set(hashToken(BEN_TOKEN), 'ben');
  const sync = async (token: string, body: { pushedEntries?: Entry[]; pushedDefinitions?: unknown[]; sinceCursor?: number } = {}) => {
    const response = await route(
      { method: 'POST', path: '/api/sync', headers: { 'x-pullup-token': token }, body: JSON.stringify({ protocolVersion: 2, pushedEntries: [], sinceCursor: 0, ...body }) },
      { db, clock: { now: () => OCT8 } },
    );
    return response as { status: number; body: SyncResponse & { error?: string } };
  };
  return { db, sync };
}

const byId = (definitions: Definition[]) => new Map(definitions.map((definition) => [definition.id, definition]));

describe('created definitions in sync', () => {
  it('creates an exercise offline-style: the definition and a set logged to it arrive in one push', async () => {
    const { db, sync } = setup();
    const lap = makeEntry({ exerciseId: STAIRS.id, reps: 3 });
    const pushed = await sync(AMA_TOKEN, { pushedEntries: [lap], pushedDefinitions: [{ ...STAIRS, createdBy: 'someone-else' }] });
    expect(pushed.status).toBe(200);
    expect(pushed.body.definitions).toEqual([{ ...STAIRS, createdBy: 'ama' }]);
    expect(db.definitions.get(STAIRS.id)).toMatchObject({ createdBy: 'ama', version: 1 });
    expect(await db.adoptedDefinitionKeys('ama')).toEqual([{ exerciseId: STAIRS.id }]);
  });

  it('reaches the creator’s other devices before anything is logged to it, and on every sync after', async () => {
    const { sync } = setup();
    await sync(AMA_TOKEN, { pushedDefinitions: [STAIRS, INTO_TUCK] });
    const otherDevice = await sync(AMA_TOKEN);
    expect(byId(otherDevice.body.definitions)).toEqual(byId([{ ...STAIRS, createdBy: 'ama' }, { ...INTO_TUCK, createdBy: 'ama' }]));
    const laterDelta = await sync(AMA_TOKEN, { sinceCursor: otherDevice.body.cursor + 60_000 });
    expect(laterDelta.body.entries).toEqual([]);
    expect(laterDelta.body.definitions).toHaveLength(2);
  });

  it('doesn’t show one person’s definitions to another until they log to one', async () => {
    const { sync } = setup();
    await sync(AMA_TOKEN, { pushedDefinitions: [STAIRS, INTO_TUCK] });
    expect((await sync(BEN_TOKEN)).body.definitions).toEqual([]);

    // Ben logs to Ama's exercise and variation (as Add to mine or a challenge will let him): both adopt.
    await sync(BEN_TOKEN, { pushedEntries: [makeEntry({ exerciseId: STAIRS.id }), makeEntry({ exerciseId: 'muscle-up', variationIds: [INTO_TUCK.id], reps: 1 })] });
    const later = await sync(BEN_TOKEN, { sinceCursor: OCT8 + 60_000 });
    expect(byId(later.body.definitions)).toEqual(byId([{ ...STAIRS, createdBy: 'ama' }, { ...INTO_TUCK, createdBy: 'ama' }]));
  });

  it('lets only the creator rename, last writer wins, and never changes measure or unit', async () => {
    const { db, sync } = setup();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await sync(AMA_TOKEN, { pushedDefinitions: [STAIRS] });
    await sync(BEN_TOKEN, { pushedEntries: [makeEntry({ exerciseId: STAIRS.id })] });

    const benRename = await sync(BEN_TOKEN, { pushedDefinitions: [{ ...STAIRS, name: 'Mine now', updatedAt: OCT8 + 10 }] });
    expect(benRename.status).toBe(200);
    expect(db.definitions.get(STAIRS.id)!.name).toBe('Red Rocks stairs');

    await sync(AMA_TOKEN, { pushedDefinitions: [{ ...STAIRS, name: 'Red Rocks', description: undefined, updatedAt: OCT8 + 20 }] });
    await sync(AMA_TOKEN, { pushedDefinitions: [{ ...STAIRS, name: 'Stale', updatedAt: OCT8 + 5 }] });
    await sync(AMA_TOKEN, { pushedDefinitions: [{ ...STAIRS, unit: 'flight', name: 'Flights', updatedAt: OCT8 + 30 }] });
    expect(db.definitions.get(STAIRS.id)).toEqual({ ...STAIRS, name: 'Red Rocks', description: undefined, updatedAt: OCT8 + 20, createdBy: 'ama', version: 2 });
    expect(errors).toHaveBeenCalledTimes(2);

    // The rename reaches Ben on his next sync, though nothing new was logged.
    const benLater = await sync(BEN_TOKEN, { sinceCursor: OCT8 + 60_000 });
    expect(benLater.body.definitions).toEqual([{ id: STAIRS.id, name: 'Red Rocks', measure: 'count', unit: 'lap', createdBy: 'ama', createdAt: OCT8, updatedAt: OCT8 + 20 }]);
    errors.mockRestore();
  });

  it('rejects a set whose amount doesn’t match its created exercise’s measure, and accepts one for an unknown exercise', async () => {
    const { db, sync } = setup();
    await sync(AMA_TOKEN, { pushedDefinitions: [STAIRS, { id: 'x-aaaaaaaaaaaaaaaa', name: 'Wall sit', measure: 'time', createdAt: OCT8, updatedAt: OCT8 }] });
    expect((await sync(AMA_TOKEN, { pushedEntries: [{ id: 'h1', doneAt: OCT8, updatedAt: 1, exerciseId: STAIRS.id, holdSeconds: 30 }] })).status).toBe(400);
    expect((await sync(AMA_TOKEN, { pushedEntries: [makeEntry({ exerciseId: 'x-aaaaaaaaaaaaaaaa' })] })).status).toBe(400);
    expect((await sync(AMA_TOKEN, { pushedEntries: [{ id: 'h2', doneAt: OCT8, updatedAt: 1, exerciseId: 'x-aaaaaaaaaaaaaaaa', holdSeconds: 30 }] })).status).toBe(200);
    const unknown = await sync(AMA_TOKEN, { pushedEntries: [makeEntry({ exerciseId: 'x-bbbbbbbbbbbbbbbb' })] });
    expect(unknown.status).toBe(200);
    expect(db.adoptions.get('ama')!.has('x-bbbbbbbbbbbbbbbb')).toBe(false);
  });

  it('counts a created exercise on the ring by its unit, and keys its day totals by its id', async () => {
    const { db, sync } = setup();
    const typewriters: ExerciseDefinition = { id: 'x-archertypewriter', name: 'Archer typewriters', measure: 'count', unit: 'rep', createdAt: OCT8, updatedAt: OCT8 };
    await sync(AMA_TOKEN, { pushedDefinitions: [STAIRS, typewriters], pushedEntries: [makeEntry({ exerciseId: STAIRS.id, reps: 3 }), makeEntry({ exerciseId: typewriters.id, reps: 10 }), makeEntry({ reps: 7 })] });
    expect(await db.getDayTotal('ama', '2026-10-08')).toMatchObject({
      reps: 17,
      sets: 3,
      byExercise: { [STAIRS.id]: { sets: 1, reps: 3, bestSetReps: 3 }, [typewriters.id]: { sets: 1, reps: 10, bestSetReps: 10 }, 'pull-up': { sets: 1, reps: 7, bestSetReps: 7 } },
    });
  });

  it('rejects malformed definitions and too many at once', async () => {
    const { sync } = setup();
    expect((await sync(AMA_TOKEN, { pushedDefinitions: [{ ...STAIRS, unit: undefined }] })).status).toBe(400);
    expect((await sync(AMA_TOKEN, { pushedDefinitions: [{ ...STAIRS, name: ' padded ' }] })).status).toBe(400);
    expect((await sync(AMA_TOKEN, { pushedDefinitions: 'nope' as never })).status).toBe(400);
    const tooMany = Array.from({ length: 101 }, (_, i) => ({ ...STAIRS, id: `x-${String.fromCharCode(97 + (i % 26)).repeat(14)}${'abcdefghijklmnopqrstuvwxyz234567'[Math.floor(i / 26)]}a` }));
    expect((await sync(AMA_TOKEN, { pushedDefinitions: tooMany })).status).toBe(400);
  });
});

describe('Add to mine', () => {
  const adopt = (db: MemoryDb, token: string, body: Record<string, unknown>) =>
    route({ method: 'POST', path: '/api/exercises/adopt', headers: { 'x-pullup-token': token }, body: JSON.stringify(body) }, { db, clock: { now: () => OCT8 } });

  it("adopts a friend's exercise, which every sync after returns", async () => {
    const { db, sync } = setup();
    await sync(AMA_TOKEN, { pushedDefinitions: [STAIRS] });
    await db.befriend('ama', 'ben', OCT8);
    const adopted = await adopt(db, BEN_TOKEN, { exerciseId: STAIRS.id, friendId: 'ama' });
    expect(adopted).toEqual({ status: 200, body: { definition: { ...STAIRS, createdBy: 'ama' } } });
    expect((await sync(BEN_TOKEN)).body.definitions).toEqual([{ ...STAIRS, createdBy: 'ama' }]);
  });

  it("refuses with one 404 for a non-friend, an exercise the friend doesn't have, and junk", async () => {
    const { db, sync } = setup();
    await sync(AMA_TOKEN, { pushedDefinitions: [STAIRS] });
    expect((await adopt(db, BEN_TOKEN, { exerciseId: STAIRS.id, friendId: 'ama' })).status).toBe(404);
    await db.befriend('ama', 'ben', OCT8);
    expect((await adopt(db, BEN_TOKEN, { exerciseId: 'x-aaaaaaaaaaaaaaaa', friendId: 'ama' })).status).toBe(404);
    expect((await adopt(db, BEN_TOKEN, { exerciseId: 'pull-up', friendId: 'ama' })).status).toBe(404);
    expect((await adopt(db, BEN_TOKEN, { exerciseId: STAIRS.id })).status).toBe(404);
    expect(await db.adoptedDefinitionKeys('ben')).toEqual([]);
  });
});
