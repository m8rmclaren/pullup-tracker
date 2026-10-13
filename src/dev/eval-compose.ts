import { readFileSync } from 'node:fs';
import { type KnownExercise, type ResolvedDraft, isValidDraft, resolveDraft } from '../shared/compose';
import { matchName } from '../shared/names';
import { bedrockComposer } from '../lambda/bedrock';
import { COMPOSE_TIMEOUT_MS, localTimeLabel } from '../lambda/compose';

// Runs test/fixtures/compose/descriptions.json against the real model on Bedrock and reports
// which drafts resolve to the expected sets. Manual, not CI: every run costs money. Needs AWS
// credentials allowed bedrock-mantle:CreateInference, and COMPOSE_MODEL_ID / AWS_REGION to override.

interface ExpectedItem {
  exercise: string | { new: string; measure: 'count' | 'time' };
  reps?: number;
  holdSeconds?: number;
  variations?: string[];
  addedWeightLbs?: number;
  /** An inclusive range. */
  minutesAgo?: [number, number];
}

interface DescriptionsFixture {
  nowMs: string;
  timeZone: string;
  known: KnownExercise[];
  cases: { name: string; text: string; expected: ExpectedItem[] }[];
}

const fixture = JSON.parse(readFileSync(new URL('../../test/fixtures/compose/descriptions.json', import.meta.url), 'utf8')) as DescriptionsFixture;
const modelId = process.env.COMPOSE_MODEL_ID ?? 'anthropic.claude-haiku-5-5';
const composer = bedrockComposer({ region: process.env.AWS_REGION ?? 'us-west-2', modelId });
const nowMs = Date.parse(fixture.nowMs);
const localTime = localTimeLabel(nowMs, fixture.timeZone);

function mismatch(resolved: ResolvedDraft, expected: ExpectedItem[]): string | null {
  if (resolved.items.length !== expected.length) return `${resolved.items.length} sets, expected ${expected.length}`;
  for (const [i, item] of resolved.items.entries()) {
    const want = expected[i]!;
    if (typeof want.exercise === 'string') {
      if (item.exerciseId !== want.exercise) return `set ${i + 1} is ${item.exerciseId ?? resolved.newExercises[item.newExerciseIndex!]?.name}, expected ${want.exercise}`;
    } else {
      const proposal = item.newExerciseIndex === undefined ? undefined : resolved.newExercises[item.newExerciseIndex];
      if (!proposal || !matchName(want.exercise.new, [{ id: 'new', name: proposal.name }]) || proposal.measure !== want.exercise.measure) return `set ${i + 1} should be a new ${want.exercise.measure} exercise like "${want.exercise.new}"`;
    }
    if (item.reps !== want.reps || item.holdSeconds !== want.holdSeconds) return `set ${i + 1} amount ${item.reps ?? item.holdSeconds}, expected ${want.reps ?? want.holdSeconds}`;
    if ([...item.variationIds].sort().join() !== [...(want.variations ?? [])].sort().join()) return `set ${i + 1} variations ${item.variationIds.join()}`;
    if ((item.addedWeightLbs ?? 0) !== (want.addedWeightLbs ?? 0)) return `set ${i + 1} weight ${item.addedWeightLbs ?? 0}`;
    const minutesAgo = Math.round((nowMs - item.doneAt) / 60_000);
    const [fromMinutes, toMinutes] = want.minutesAgo ?? [0, 1];
    if (minutesAgo < fromMinutes || minutesAgo > toMinutes) return `set ${i + 1} ${minutesAgo} minutes ago`;
  }
  return null;
}

let passed = 0;
let inputTokens = 0;
let outputTokens = 0;
for (const testCase of fixture.cases) {
  const startedAtMs = Date.now();
  try {
    const output = await composer.compose({ text: testCase.text, localTime, exerciseNames: fixture.known.map((exercise) => exercise.name) }, AbortSignal.timeout(COMPOSE_TIMEOUT_MS * 2));
    inputTokens += output.inputTokens;
    outputTokens += output.outputTokens;
    const problem = !isValidDraft(output.draft) ? 'not a valid draft' : mismatch(resolveDraft(output.draft, fixture.known, () => [], nowMs), testCase.expected);
    if (!problem) passed++;
    console.log(`${problem ? 'FAIL' : 'pass'}  ${testCase.name}  (${Date.now() - startedAtMs} ms)${problem ? `\n      ${problem}\n      ${JSON.stringify(output.draft)}` : ''}`);
  } catch (error) {
    console.log(`FAIL  ${testCase.name}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
}
console.log(`\n${passed}/${fixture.cases.length} passed on ${modelId}; ${inputTokens} input and ${outputTokens} output tokens, about $${((inputTokens * 0.1 + outputTokens * 0.5) / 1e6).toFixed(4)} at first-party Haiku prices.`);
