import { describe, expect, it } from 'vitest';
import type { Entry } from '../src/shared/model';
import { hashToken } from '../src/lambda/auth';
import { route } from '../src/lambda/http';
import { MemoryStore } from '../src/lambda/store';
import { handleSync } from '../src/lambda/sync';

const OCT = Date.parse('2026-10-08T18:00:00Z');
const NOV = Date.parse('2026-11-02T18:00:00Z');
let n = 0;
const e = (ts: number, reps = 5, extra: Partial<Entry> = {}): Entry => ({ id: `id${++n}`, ts, reps, updatedAt: 1, ...extra });

/** Yields between every read and write so concurrent requests interleave the worst way. */
class InterleavingStore extends MemoryStore {
  override async get(key: string) {
    const v = await super.get(key);
    await new Promise((r) => setTimeout(r, 1));
    return v;
  }
}

describe('handleSync', () => {
  it('partitions by Denver month and returns only months the client lacks', async () => {
    const store = new MemoryStore();
    const a = e(OCT);
    const b = e(NOV);
    const r1 = await handleSync(store, { push: [a, b], have: {} });
    expect(Object.keys(r1.months).sort()).toEqual(['2026-10', '2026-11']);
    expect([...store.objects.keys()].sort()).toEqual(['months/2026-10.json', 'months/2026-11.json']);

    const have = Object.fromEntries(Object.entries(r1.months).map(([m, d]) => [m, d.etag]));
    expect((await handleSync(store, { push: [], have })).months).toEqual({});

    const c = e(OCT + 60_000);
    const r3 = await handleSync(store, { push: [c], have });
    expect(Object.keys(r3.months)).toEqual(['2026-10']);
    expect(r3.months['2026-10']!.entries.map((x) => x.id)).toEqual([a.id, c.id]);
  });

  it('does not rewrite a month when the push changes nothing', async () => {
    const store = new MemoryStore();
    const a = e(OCT);
    const r1 = await handleSync(store, { push: [a], have: {} });
    const r2 = await handleSync(store, { push: [a], have: {} });
    expect(r2.months['2026-10']!.etag).toBe(r1.months['2026-10']!.etag);
  });

  it('loses no sets when many devices push to the same month at once', async () => {
    const store = new InterleavingStore();
    const pushes = Array.from({ length: 12 }, (_, i) => [e(OCT + i * 1000, (i % 6) + 3)]);
    await Promise.all(pushes.map((push) => handleSync(store, { push, have: {} })));
    const final = await handleSync(store, { push: [], have: {} });
    expect(final.months['2026-10']!.entries).toHaveLength(12);
  });

  it('a concurrent edit and delete converge to the newer one', async () => {
    const store = new InterleavingStore();
    const base = e(OCT, 5);
    await handleSync(store, { push: [base], have: {} });
    await Promise.all([
      handleSync(store, { push: [{ ...base, reps: 7, updatedAt: 10 }], have: {} }),
      handleSync(store, { push: [{ ...base, deleted: true, updatedAt: 11 }], have: {} }),
    ]);
    const final = await handleSync(store, { push: [], have: {} });
    expect(final.months['2026-10']!.entries).toEqual([{ ...base, deleted: true, updatedAt: 11 }]);
  });
});

describe('route', () => {
  const token = 'a-long-enough-test-token-0123456789';
  const deps = () => ({ store: new MemoryStore(), tokenHashes: async () => [hashToken('old-token-being-rotated-out-xx'), hashToken(token)] });
  const req = (over: Partial<Parameters<typeof route>[0]> = {}) => ({
    method: 'POST',
    path: '/api/sync',
    headers: { 'x-pullup-token': token },
    body: JSON.stringify({ push: [e(OCT)], have: {} }),
    ...over,
  });

  it('accepts any currently valid token', async () => {
    expect((await route(req(), deps())).status).toBe(200);
    expect((await route(req({ headers: { 'x-pullup-token': 'old-token-being-rotated-out-xx' } }), deps())).status).toBe(200);
  });

  it('rejects a missing or wrong token before touching storage', async () => {
    const d = deps();
    expect((await route(req({ headers: {} }), d)).status).toBe(401);
    expect((await route(req({ headers: { 'x-pullup-token': token + 'x' } }), d)).status).toBe(401);
    expect(d.store.objects.size).toBe(0);
  });

  it('rejects invalid bodies and unknown routes', async () => {
    expect((await route(req({ body: '{' }), deps())).status).toBe(400);
    expect((await route(req({ body: JSON.stringify({ push: [{ id: 'x', reps: 999 }] }) }), deps())).status).toBe(400);
    expect((await route(req({ method: 'GET' }), deps())).status).toBe(405);
    expect((await route(req({ path: '/api/other' }), deps())).status).toBe(404);
  });
});
