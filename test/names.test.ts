import { describe, expect, it } from 'vitest';
import { type NamedItem, editDistance, matchName, nameKey, searchNames } from '../src/shared/names';
import { loadFixture } from './fixtures';

interface NamesFixture {
  items: NamedItem[];
  matches: { name: string; query: string; expected: string | null }[];
  searches: { name: string; query: string; expected: string[] }[];
}

const fixture = loadFixture<NamesFixture>('compose/names.json');

describe('matchName', () => {
  for (const testCase of fixture.matches) {
    it(testCase.name, () => {
      expect(matchName(testCase.query, fixture.items)?.id ?? null).toBe(testCase.expected);
    });
  }
});

describe('searchNames', () => {
  for (const testCase of fixture.searches) {
    it(testCase.name, () => {
      expect(searchNames(testCase.query, fixture.items).map((item) => item.id)).toEqual(testCase.expected);
    });
  }
});

describe('helpers', () => {
  it('keys names', () => {
    expect(nameKey('Push-Ups!')).toBe('pushup');
    expect(nameKey('Press')).toBe('press');
  });

  it('measures edit distance', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('', 'abc')).toBe(3);
  });
});
