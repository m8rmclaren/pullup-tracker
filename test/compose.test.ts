import { describe, expect, it } from 'vitest';
import { type ComposedDraft, type KnownExercise, type ResolvedDraft, isValidComposeRequest, isValidDraft, resolveDraft } from '../src/shared/compose';
import type { NamedItem } from '../src/shared/names';
import { hashToken } from '../src/lambda/auth';
import { type ComposeConfig, type Composer, type ComposerInput, MAX_COMPOSES_PER_DAY } from '../src/lambda/compose';
import { MemoryDb } from '../src/lambda/db';
import { route } from '../src/lambda/http';
import { instantMs, loadFixture } from './fixtures';

interface DraftsFixture {
  nowMs: string;
  known: KnownExercise[];
  knownVariations: Record<string, NamedItem[]>;
  cases: { name: string; draft: ComposedDraft; expected: ResolvedDraft }[];
  drafts: { name: string; value: unknown; valid: boolean }[];
}

const fixture = loadFixture<DraftsFixture>('compose/drafts.json');

describe('compose/drafts.json resolveDraft', () => {
  it.each(fixture.cases)('$name', ({ draft, expected }) => {
    expect(isValidDraft(draft)).toBe(true);
    expect(resolveDraft(draft, fixture.known, (exerciseId) => fixture.knownVariations[exerciseId] ?? [], instantMs(fixture.nowMs))).toEqual(expected);
  });
});

describe('compose/drafts.json isValidDraft', () => {
  it.each(fixture.drafts)('$name', ({ value, valid }) => {
    expect(isValidDraft(value)).toBe(valid);
  });
});

describe('isValidComposeRequest', () => {
  const request = { text: 'ran the stairs 3 times', nowMs: 1, timeZone: 'America/Denver', knownExercises: [{ id: 'pull-up', name: 'Pull-up', measure: 'count', unit: 'rep' }] };

  it('takes text, a time, a zone and the known exercises', () => {
    expect(isValidComposeRequest(request)).toBe(true);
  });

  it.each([
    ['blank text', { text: '   ' }],
    ['text too long', { text: 'x'.repeat(1001) }],
    ['a made-up zone', { timeZone: 'Mars/Olympus' }],
    ['a known exercise without a measure', { knownExercises: [{ id: 'pull-up', name: 'Pull-up' }] }],
  ])('refuses %s', (_, change) => {
    expect(isValidComposeRequest({ ...request, ...change })).toBe(false);
  });
});

describe('POST /api/compose', () => {
  const NOW = Date.parse('2026-10-08T18:05:00-06:00');
  const TOKEN = 'device-token-for-ama-0123456789ab';
  const body = { text: '4x8 wide pull-ups', nowMs: NOW, timeZone: 'America/Denver', knownExercises: [{ id: 'pull-up', name: 'Pull-up', measure: 'count', unit: 'rep' }, { id: 'x-k3p9aaaaaaaaaaaa', name: 'Red Rocks stairs', measure: 'count', unit: 'lap' }] };
  const draft: ComposedDraft = { sets: [{ exercise: 'Pull-up', variations: ['Wide grip'], reps: 8, repeat: 4, minutesAgo: 0 }], newExercises: [] };

  function setup(composer: Composer | null, monthlyCeilingUsd = 5) {
    const db = new MemoryDb();
    db.users.set('ama', { id: 'ama', name: 'Ama', createdAt: 1, timeZone: 'America/Denver' });
    db.tokens.set(hashToken(TOKEN), 'ama');
    const config: ComposeConfig | undefined = composer ? { composer, monthlyCeilingUsd, inputUsdPerMillionTokens: 0.1, outputUsdPerMillionTokens: 0.5 } : undefined;
    const post = (payload: unknown = body) => route({ method: 'POST', path: '/api/compose', headers: { 'x-pullup-token': TOKEN }, body: JSON.stringify(payload) }, { db, clock: { now: () => NOW }, compose: config });
    return { db, post };
  }

  it('sends the model the text, the local time and names only, and returns a valid draft', async () => {
    const seen: ComposerInput[] = [];
    const { db, post } = setup({ compose: async (input) => (seen.push(input), { draft, inputTokens: 2000, outputTokens: 300 }) });
    expect(await post()).toEqual({ status: 200, body: { draft } });
    expect(seen).toEqual([{ text: '4x8 wide pull-ups', localTime: 'Thursday 2026-10-08 18:05', exerciseNames: ['Pull-up', 'Red Rocks stairs'] }]);
    expect(await db.getComposeSpend('2026-10')).toEqual({ spentMicroUsd: 350, version: 1 });
    expect(await db.getDailyCount('ama', 'compose', '2026-10-08')).toEqual({ count: 1, version: 1 });
  });

  it('answers null for anything that is not a draft', async () => {
    const { post } = setup({ compose: async () => ({ draft: { sets: [{ exercise: 'Pull-up', reps: 8 }] }, inputTokens: 1, outputTokens: 1 }) });
    expect(await post()).toEqual({ status: 200, body: { draft: null } });
  });

  it('stops at 30 a day, counting failed calls too', async () => {
    let calls = 0;
    const { post } = setup({ compose: async () => (calls++ % 2 ? { draft, inputTokens: 1, outputTokens: 1 } : Promise.reject(new Error('throttled'))) });
    for (let i = 0; i < MAX_COMPOSES_PER_DAY; i++) expect([200, 503]).toContain((await post()).status);
    expect((await post()).status).toBe(429);
    expect(calls).toBe(MAX_COMPOSES_PER_DAY);
  });

  it('rests past the monthly ceiling without calling the model', async () => {
    let calls = 0;
    const { db, post } = setup({ compose: async () => (calls++, { draft, inputTokens: 1, outputTokens: 1 }) }, 1);
    await db.putComposeSpend('2026-10', { spentMicroUsd: 1_000_000, version: 1 }, null);
    const response = await post();
    expect(response.status).toBe(503);
    expect(calls).toBe(0);
  });

  it('answers 503 without a model, 400 for junk, and 401 signed out', async () => {
    const { post } = setup(null);
    expect((await post()).status).toBe(503);
    expect((await post({ ...body, text: '' })).status).toBe(400);
    const signedOut = await route({ method: 'POST', path: '/api/compose', headers: {}, body: JSON.stringify(body) }, { db: new MemoryDb() });
    expect(signedOut.status).toBe(401);
  });
});
