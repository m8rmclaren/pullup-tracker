import { builtInVariation, isCreatedVariationId } from './catalog';
import { type Entry, MAX_VARIATIONS, exerciseIdOf } from './model';
import { addDays, dayKey } from './time';

// What the Today pad offers, derived from history: the exercise and configuration to prefill,
// the counts around your usual, and past sessions to repeat. Pure, so the iOS client can run
// the same rules.

/** An exercise and its configuration: what a set is of, apart from its amount. */
export interface SetContext {
  exerciseId: string;
  /** Unique and sorted, as entries store them. */
  variationIds: string[];
}

/** One set to log, without an id or a time: a repeat, a queue item, a composed draft. */
export interface SetTemplate extends SetContext {
  reps?: number;
  holdSeconds?: number;
  addedWeightLbs?: number;
}

/** A gap this long or longer starts a new session, so there is no "start workout" to forget. */
export const SESSION_GAP_MS = 90 * 60_000;
const USUAL_WINDOW_DAYS = 30;
export const PAD_SIZE = 6;
/** Quick durations a timed pad picks six from, around your usual hold. */
export const HOLD_STEPS_SECONDS = [5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 300, 600, 900, 1200, 1800, 3600];

const newestFirst = (a: Entry, b: Entry) => b.doneAt - a.doneAt || (a.id < b.id ? 1 : -1);

function liveNewestFirst(entries: Iterable<Entry>): Entry[] {
  const live: Entry[] = [];
  for (const entry of entries) if (!entry.deleted) live.push(entry);
  return live.sort(newestFirst);
}

export const contextOf = (entry: Entry): SetContext => ({ exerciseId: exerciseIdOf(entry), variationIds: entry.variationIds ?? [] });

export const sameContext = (a: SetContext, b: SetContext) => a.exerciseId === b.exerciseId && a.variationIds.join(',') === b.variationIds.join(',');

export function templateOf(entry: Entry): SetTemplate {
  const template: SetTemplate = contextOf(entry);
  if (entry.reps !== undefined) template.reps = entry.reps;
  if (entry.holdSeconds !== undefined) template.holdSeconds = entry.holdSeconds;
  if (entry.addedWeightLbs) template.addedWeightLbs = entry.addedWeightLbs;
  return template;
}

/** The most recently done live set, which "Repeat last set" copies; null with no history. */
export function lastSet(entries: Iterable<Entry>): Entry | null {
  return liveNewestFirst(entries)[0] ?? null;
}

/** Exercises by most recent use, newest first, without repeats. */
export function recentExerciseIds(entries: Iterable<Entry>, limit: number): string[] {
  const exerciseIds: string[] = [];
  for (const entry of liveNewestFirst(entries)) {
    const exerciseId = exerciseIdOf(entry);
    if (!exerciseIds.includes(exerciseId)) exerciseIds.push(exerciseId);
    if (exerciseIds.length === limit) break;
  }
  return exerciseIds;
}

/** Variations you've used with an exercise, most recent first, without repeats. */
export function recentVariationIds(entries: Iterable<Entry>, exerciseId: string, limit: number): string[] {
  const variationIds: string[] = [];
  for (const entry of liveNewestFirst(entries)) {
    if (exerciseIdOf(entry) !== exerciseId) continue;
    for (const variationId of entry.variationIds ?? []) if (!variationIds.includes(variationId)) variationIds.push(variationId);
    if (variationIds.length >= limit) break;
  }
  return variationIds.slice(0, limit);
}

/** The context of your most recent set of this exercise: what picking it prefills. */
export function lastContextFor(entries: Iterable<Entry>, exerciseId: string): SetContext {
  const entry = liveNewestFirst(entries).find((candidate) => exerciseIdOf(candidate) === exerciseId);
  return entry ? contextOf(entry) : { exerciseId, variationIds: [] };
}

/**
 * Turns a variation on or off. A built-in variation is at most one per group, so turning one on
 * turns off any other from its group. Created variations have no group. A set holds at most
 * MAX_VARIATIONS, so turning on one more past that changes nothing.
 */
export function toggleVariation(variationIds: string[], variationId: string): string[] {
  if (variationIds.includes(variationId)) return variationIds.filter((id) => id !== variationId);
  const group = isCreatedVariationId(variationId) ? undefined : builtInVariation(variationId)?.group;
  const kept = group ? variationIds.filter((id) => isCreatedVariationId(id) || builtInVariation(id)?.group !== group) : variationIds;
  if (kept.length >= MAX_VARIATIONS) return variationIds;
  return [...kept, variationId].sort();
}

function mostCommon(amounts: number[]): number | null {
  const countsByAmount = new Map<number, number>();
  for (const amount of amounts) countsByAmount.set(amount, (countsByAmount.get(amount) ?? 0) + 1);
  let usual: number | null = null;
  let usualCount = 0;
  for (const [amount, count] of countsByAmount) {
    if (count > usualCount || (count === usualCount && usual !== null && amount > usual)) {
      usual = amount;
      usualCount = count;
    }
  }
  return usual;
}

/**
 * The amount logged most often for this context in the last 30 days (reps, or seconds for a
 * hold), ties to the larger. Falls back to the exercise with any configuration, then null.
 */
export function usualAmount(entries: Iterable<Entry>, context: SetContext, nowMs: number, timeZone: string): number | null {
  const cutoff = addDays(dayKey(nowMs, timeZone), -(USUAL_WINDOW_DAYS - 1));
  const sameExercise: Entry[] = [];
  for (const entry of entries) {
    if (entry.deleted || exerciseIdOf(entry) !== context.exerciseId || dayKey(entry.doneAt, timeZone) < cutoff) continue;
    sameExercise.push(entry);
  }
  const amountOf = (entry: Entry) => entry.reps ?? entry.holdSeconds!;
  const exact = sameExercise.filter((entry) => sameContext(contextOf(entry), context));
  return mostCommon(exact.map(amountOf)) ?? mostCommon(sameExercise.map(amountOf));
}

/**
 * Six counts around your usual: two below and three above, never below 1. With no usual, a
 * rep-counted exercise starts at 3 and anything else at 1.
 */
export function padCounts(usual: number | null, unit: string | undefined): number[] {
  const start = usual === null ? (unit === 'rep' ? 3 : 1) : Math.max(1, usual - 2);
  return Array.from({ length: PAD_SIZE }, (_, i) => start + i);
}

/** Six quick durations around your usual hold, from HOLD_STEPS_SECONDS. With no usual, 10s to 60s. */
export function padHoldSeconds(usual: number | null): number[] {
  const target = usual ?? 20;
  let nearest = 0;
  for (let i = 0; i < HOLD_STEPS_SECONDS.length; i++) {
    if (Math.abs(HOLD_STEPS_SECONDS[i]! - target) < Math.abs(HOLD_STEPS_SECONDS[nearest]! - target)) nearest = i;
  }
  const start = Math.min(Math.max(0, nearest - 2), HOLD_STEPS_SECONDS.length - PAD_SIZE);
  const steps = HOLD_STEPS_SECONDS.slice(start, start + PAD_SIZE);
  // A usual between steps (say 40s) is offered as itself.
  if (usual !== null && !steps.includes(usual)) steps[Math.min(2, PAD_SIZE - 1)] = usual;
  return steps.sort((a, b) => a - b);
}

export interface Session {
  /** The first set's doneAt, which also identifies the session. */
  startMs: number;
  endMs: number;
  /** Oldest first, the order a repeat walks them. */
  entries: Entry[];
}

/** Live sets grouped into sessions, newest session first. */
export function sessionsOf(entries: Iterable<Entry>): Session[] {
  const oldestFirst = liveNewestFirst(entries).reverse();
  const sessions: Session[] = [];
  for (const entry of oldestFirst) {
    const current = sessions[sessions.length - 1];
    if (current && entry.doneAt - current.endMs < SESSION_GAP_MS) {
      current.entries.push(entry);
      current.endMs = entry.doneAt;
    } else {
      sessions.push({ startMs: entry.doneAt, endMs: entry.doneAt, entries: [entry] });
    }
  }
  return sessions.reverse();
}

/**
 * Past sessions worth offering as a repeat, newest first: more than one set, and over (the
 * last set is at least a session gap ago, so it isn't the one you're in).
 */
export function repeatableSessions(entries: Iterable<Entry>, nowMs: number, limit: number): Session[] {
  return sessionsOf(entries)
    .filter((session) => session.entries.length > 1 && nowMs - session.endMs >= SESSION_GAP_MS)
    .slice(0, limit);
}
