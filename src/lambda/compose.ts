import { type ComposeResponse, type ComposedDraft, type KnownExercise, isValidComposeRequest, isValidDraft } from '../shared/compose';
import { DEFAULT_TIME_ZONE, addDays, dayKey, wallClockToEpochMs } from '../shared/time';
import { type Db, PreconditionFailed } from './db';
import { RequestError } from './errors';
import type { Clock } from './sync';

/** What the model is given: the text, the local time, and the names it may use. Never ids, a name or a user id. */
export interface ComposerInput {
  text: string;
  /** The person's wall-clock time, e.g. "Thursday 2026-10-08 18:05", so "yesterday evening" can become minutes ago. */
  localTime: string;
  exerciseNames: string[];
}

export interface ComposerOutput {
  /** Null for a refusal or anything that isn't a draft. */
  draft: unknown;
  inputTokens: number;
  outputTokens: number;
}

/** The model behind /api/compose (Claude Haiku on Bedrock in the Lambda; a fake in tests). */
export interface Composer {
  compose(input: ComposerInput, signal: AbortSignal): Promise<ComposerOutput>;
}

export interface ComposeConfig {
  composer: Composer;
  /** Past this, Describe rests until next month. */
  monthlyCeilingUsd: number;
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
}

export const MAX_COMPOSES_PER_DAY = 30;
export const COMPOSE_TIMEOUT_MS = 5000;
const MAX_ATTEMPTS = 8;
const SPEND_ATTEMPTS = 3;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** "Thursday 2026-10-08 18:05": the local time the model counts minutesAgo back from. */
export function localTimeLabel(nowMs: number, timeZone: string): string {
  const day = dayKey(nowMs, timeZone);
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(nowMs);
  return `${WEEKDAYS[new Date(`${day}T12:00:00Z`).getUTCDay()]} ${day} ${clock}`;
}

/** Counts one more compose against today's cap, or refuses it. Counted before the call, so a failed one still counts. */
async function countCompose(db: Db, userId: string, clock: Clock): Promise<void> {
  const user = await db.getUser(userId);
  const timeZone = user?.timeZone ?? DEFAULT_TIME_ZONE;
  const today = dayKey(clock.now(), timeZone);
  const ttlEpochSeconds = Math.ceil(wallClockToEpochMs(addDays(today, 2), '00:00', timeZone) / 1000);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const stored = await db.getDailyCount(userId, 'compose', today);
    if ((stored?.count ?? 0) >= MAX_COMPOSES_PER_DAY) throw new RequestError(429, "That's all the Describes for today. The pad still works.");
    try {
      await db.putDailyCount(userId, 'compose', today, { count: (stored?.count ?? 0) + 1, version: (stored?.version ?? 0) + 1 }, stored?.version ?? null, ttlEpochSeconds);
      return;
    } catch (error) {
      if (!(error instanceof PreconditionFailed)) throw error;
    }
  }
  throw new Error(`gave up counting a compose for ${userId} after ${MAX_ATTEMPTS} conflicting writes`);
}

const utcMonth = (nowMs: number) => new Date(nowMs).toISOString().slice(0, 7);

/** Adds a call's cost to the month. Best effort: losing a race three times drops it, logged, rather than failing a draft already made. */
async function recordSpend(db: Db, month: string, costMicroUsd: number): Promise<void> {
  for (let attempt = 0; attempt < SPEND_ATTEMPTS; attempt++) {
    const stored = await db.getComposeSpend(month);
    try {
      await db.putComposeSpend(month, { spentMicroUsd: (stored?.spentMicroUsd ?? 0) + costMicroUsd, version: (stored?.version ?? 0) + 1 }, stored?.version ?? null);
      return;
    } catch (error) {
      if (!(error instanceof PreconditionFailed)) throw error;
    }
  }
  console.error(`dropped ${costMicroUsd} micro-USD of compose spend for ${month} after ${SPEND_ATTEMPTS} conflicting writes`);
}

/**
 * POST /api/compose: a sentence in, a draft of sets out, for the client to resolve and show.
 * It never writes a set. Capped per person per day, and across everyone per month.
 */
export async function compose(db: Db, userId: string, body: Record<string, unknown>, config: ComposeConfig | undefined, clock: Clock): Promise<ComposeResponse> {
  if (!isValidComposeRequest(body)) throw new RequestError(400, 'text, nowMs, timeZone and knownExercises are required.');
  if (!config) throw new RequestError(503, "Describe isn't set up on this server. The pad still works.");
  const month = utcMonth(clock.now());
  const spend = await db.getComposeSpend(month);
  if ((spend?.spentMicroUsd ?? 0) >= config.monthlyCeilingUsd * 1_000_000) throw new RequestError(503, 'Describe is resting until next month. The pad still works.');
  await countCompose(db, userId, clock);

  const input: ComposerInput = { text: body.text.trim(), localTime: localTimeLabel(body.nowMs, body.timeZone), exerciseNames: [...new Set((body.knownExercises as KnownExercise[]).map((exercise) => exercise.name))] };
  let output: ComposerOutput;
  try {
    output = await config.composer.compose(input, AbortSignal.timeout(COMPOSE_TIMEOUT_MS));
  } catch (error) {
    console.error(`composing a draft for ${userId} failed`, error);
    throw new RequestError(503, "Couldn't reach Describe just now. The pad still works.");
  }

  const costMicroUsd = Math.ceil(output.inputTokens * config.inputUsdPerMillionTokens + output.outputTokens * config.outputUsdPerMillionTokens);
  try {
    await recordSpend(db, month, costMicroUsd);
  } catch (error) {
    console.error(`recording compose spend for ${month} failed`, error);
  }
  return { draft: isValidDraft(output.draft) ? (output.draft as ComposedDraft) : null };
}
