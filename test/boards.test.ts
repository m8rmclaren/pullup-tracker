import { describe, expect, it } from 'vitest';
import { type BoardMember, type BoardSpec, evaluateBoard, groupTotal, periodWindow, requestWindow } from '../src/shared/boards';
import { expectMatches, instantMs, loadFixture } from './fixtures';

interface BoardCase {
  name: string;
  now: string;
  spec: BoardSpec;
  members: BoardMember[];
  rows: { id: string; name: string; value: number | null; rank: number | null }[];
  groupTotal?: number;
}

const { cases } = loadFixture<{ cases: BoardCase[] }>('boards.json');

describe('boards.json', () => {
  for (const boardCase of cases) {
    it(boardCase.name, () => {
      const rows = evaluateBoard(boardCase.spec, boardCase.members, instantMs(boardCase.now));
      expect(rows.map((row) => row.id)).toEqual(boardCase.rows.map((row) => row.id));
      expectMatches(rows, boardCase.rows);
      if (boardCase.groupTotal !== undefined) {
        expect(typeof boardCase.spec.period).toBe('object');
        expect(groupTotal(boardCase.spec.exerciseId!, boardCase.spec.period as { fromDay: string; toDay: string }, boardCase.members)).toBe(boardCase.groupTotal);
      }
    });
  }
});

describe('board windows', () => {
  const now = Date.parse('2026-10-14T18:00:00Z');
  it('starts weeks on Monday and months on the first, in the member’s zone', () => {
    expect(periodWindow('week', now, 'America/Denver')).toEqual({ fromDay: '2026-10-12', toDay: '2026-10-14' });
    expect(periodWindow('month', now, 'Pacific/Auckland')).toEqual({ fromDay: '2026-10-01', toDay: '2026-10-15' });
    expect(periodWindow({ fromDay: '2026-10-01', toDay: '2026-10-31' }, now, 'Europe/London')).toEqual({ fromDay: '2026-10-01', toDay: '2026-10-31' });
  });

  it('asks the server for two days either side, so a friend in any zone is covered', () => {
    expect(requestWindow('today', now, 'America/Denver')).toEqual({ fromDay: '2026-10-12', toDay: '2026-10-16' });
  });
});
