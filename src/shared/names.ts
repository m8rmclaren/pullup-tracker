// Matching what someone typed or said ("push ups", "red rocks") to an exercise or variation
// they can see. Deterministic, so the picker's search, the composer's resolver and the Swift
// client agree (test/fixtures/compose/names.json).

export interface NamedItem {
  id: string;
  name: string;
}

/** Lowercase words without accents or punctuation, each with a plural "s" dropped: "Push-Ups!" → ["push", "up"]. */
export function nameWords(name: string): string[] {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map(singular);
}

function singular(word: string): string {
  if (word.length >= 3 && word.endsWith('s') && !word.endsWith('ss') && !/^\d+$/.test(word)) return word.slice(0, -1);
  return word;
}

/** One key per name, so "pull-ups", "Pull ups" and "pullup" collide. */
export const nameKey = (name: string): string => nameWords(name).join('');

export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    previous = current;
  }
  return previous[b.length]!;
}

/** Typos allowed for a key this long: none under 5 characters, then one per 5, at most 3. */
export const typoAllowance = (keyLength: number): number => Math.min(3, Math.floor(keyLength / 5));

/**
 * The one item a name means, or undefined: an exact key match, else the only item whose words
 * include every word of the name ("red rocks" → "Red Rocks stairs"), else the only item within
 * the typo allowance at the smallest distance. Anything ambiguous is no match, so a guess never
 * lands a set on the wrong exercise.
 */
export function matchName<T extends NamedItem>(name: string, items: T[]): T | undefined {
  const key = nameKey(name);
  if (!key) return undefined;
  const exact = items.filter((item) => nameKey(item.name) === key);
  if (exact.length) return unique(exact);

  const words = nameWords(name);
  const containing = items.filter((item) => {
    const itemWords = nameWords(item.name);
    return words.every((word) => itemWords.includes(word));
  });
  if (containing.length) return unique(containing);

  const allowance = typoAllowance(key.length);
  let best: T[] = [];
  let bestDistance = Infinity;
  for (const item of items) {
    const distance = editDistance(key, nameKey(item.name));
    if (distance > allowance) continue;
    if (distance < bestDistance) {
      best = [item];
      bestDistance = distance;
    } else if (distance === bestDistance) {
      best.push(item);
    }
  }
  return unique(best);
}

/** Several items sharing one id (an exercise listed twice) still count as one. */
function unique<T extends NamedItem>(items: T[]): T | undefined {
  return new Set(items.map((item) => item.id)).size === 1 ? items[0] : undefined;
}

/**
 * Items for a search box, best first: exact, then names starting with the query, then names
 * containing every word of it, then near misses. An empty query returns nothing.
 */
export function searchNames<T extends NamedItem>(query: string, items: T[]): T[] {
  const key = nameKey(query);
  if (!key) return [];
  const words = nameWords(query);
  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const itemKey = nameKey(item.name);
    const itemWords = nameWords(item.name);
    let score: number | null = null;
    if (itemKey === key) score = 0;
    else if (itemKey.startsWith(key)) score = 1;
    else if (words.every((word) => itemWords.some((itemWord) => itemWord.startsWith(word)))) score = 2;
    else if (itemKey.includes(key)) score = 3;
    else if (editDistance(key, itemKey.slice(0, key.length)) <= typoAllowance(key.length)) score = 4;
    if (score !== null) scored.push({ item, score });
  }
  return scored.sort((a, b) => a.score - b.score || a.item.name.localeCompare(b.item.name)).map((entry) => entry.item);
}
