import { type DayTotalRecord, type ExerciseDayTotal, exerciseDayTotals } from './stats';
import { addDays, dayKey, daysBetween, startOfWeek } from './time';

// Leaderboards are evaluated on the client, over raw day totals the server returns. A board
// is a small spec, so a new metric, period or tiebreak ships in a client release, and the
// Swift client runs the same cases (test/fixtures/boards.json).

export type BoardMetric = 'count' | 'sets' | 'bestSet' | 'activeDays' | 'goalPercent';
export type BoardPeriod = 'today' | 'week' | 'month' | { fromDay: string; toDay: string };

export interface BoardSpec {
  metric: BoardMetric;
  /** Absent: across exercises, which for count and bestSet means the ring (rep-unit sets). */
  exerciseId?: string;
  period: BoardPeriod;
}

/** A stored day total as the server returns it; one written before v2 lacks holdSeconds and byExercise. */
export type BoardDay = Pick<DayTotalRecord, 'day' | 'reps' | 'sets' | 'bestSetReps'> & Partial<Pick<DayTotalRecord, 'holdSeconds' | 'byExercise'>>;

export interface BoardMember {
  id: string;
  name: string;
  timeZone: string;
  /** Absent until the member sets one; goalPercent has no value for them. */
  dailyGoalReps?: number;
  days: BoardDay[];
}

export interface BoardRow {
  id: string;
  name: string;
  /** null where the metric has no value for this member (goalPercent without a goal). */
  value: number | null;
  /** Shared by members tied on value and tiebreak (1, 1, 3); null with no value. */
  rank: number | null;
}

/** The metrics a board can rank by; every one but count breaks ties by count. */
export const BOARD_METRICS: BoardMetric[] = ['count', 'sets', 'bestSet', 'activeDays', 'goalPercent'];

/** The days a period covers for one member, in their own zone: weeks start Monday, and open periods end today. */
export function periodWindow(period: BoardPeriod, nowMs: number, timeZone: string): { fromDay: string; toDay: string } {
  if (typeof period === 'object') return period;
  const today = dayKey(nowMs, timeZone);
  if (period === 'today') return { fromDay: today, toDay: today };
  if (period === 'week') return { fromDay: startOfWeek(today), toDay: today };
  return { fromDay: `${today.slice(0, 7)}-01`, toDay: today };
}

/** The widest window any member's period could need, for asking the server: zones put todays up to two dates apart. */
export function requestWindow(period: BoardPeriod, nowMs: number, timeZone: string): { fromDay: string; toDay: string } {
  if (typeof period === 'object') return period;
  const { fromDay, toDay } = periodWindow(period, nowMs, timeZone);
  return { fromDay: addDays(fromDay, -2), toDay: addDays(toDay, 2) };
}

function exerciseShare(day: BoardDay, exerciseId: string): ExerciseDayTotal | undefined {
  return exerciseDayTotals(day)[exerciseId];
}

/** count across a member's days in the window: the exercise's own unit, or ring reps across exercises. */
function countIn(days: BoardDay[], exerciseId: string | undefined): number {
  let total = 0;
  for (const day of days) {
    if (exerciseId === undefined) total += day.reps;
    else {
      const share = exerciseShare(day, exerciseId);
      total += (share?.reps ?? 0) + (share?.holdSeconds ?? 0);
    }
  }
  return total;
}

function metricValue(metric: BoardMetric, exerciseId: string | undefined, days: BoardDay[], member: BoardMember, window: { fromDay: string; toDay: string }, nowMs: number): number | null {
  switch (metric) {
    case 'count':
      return countIn(days, exerciseId);
    case 'sets':
      return days.reduce((total, day) => total + (exerciseId === undefined ? day.sets : (exerciseShare(day, exerciseId)?.sets ?? 0)), 0);
    case 'bestSet':
      return days.reduce((best, day) => {
        if (exerciseId === undefined) return Math.max(best, day.bestSetReps);
        const share = exerciseShare(day, exerciseId);
        return Math.max(best, share?.bestSetReps ?? share?.bestHoldSeconds ?? 0);
      }, 0);
    case 'activeDays':
      return days.filter((day) => (exerciseId === undefined ? day.sets : (exerciseShare(day, exerciseId)?.sets ?? 0)) > 0).length;
    case 'goalPercent': {
      // Against the ring goal whatever the exercise: the goal is a ring number.
      if (!member.dailyGoalReps) return null;
      const lastDay = minDay(window.toDay, dayKey(nowMs, member.timeZone));
      const elapsedDays = Math.max(1, daysBetween(window.fromDay, lastDay) + 1);
      return (100 * countIn(days, undefined)) / (member.dailyGoalReps * elapsedDays);
    }
  }
}

const minDay = (a: string, b: string) => (a < b ? a : b);

function daysInWindow(member: BoardMember, window: { fromDay: string; toDay: string }): BoardDay[] {
  return member.days.filter((day) => day.day >= window.fromDay && day.day <= window.toDay);
}

/**
 * Ranks members by the spec's metric over each one's own period. Higher is better. Ties on
 * the value break by count (except for count itself); members still tied share a rank and are
 * listed by name, then id. A member without a value is listed last, unranked.
 */
export function evaluateBoard(spec: BoardSpec, members: BoardMember[], nowMs: number): BoardRow[] {
  const scored = members.map((member) => {
    const window = periodWindow(spec.period, nowMs, member.timeZone);
    const days = daysInWindow(member, window);
    return {
      member,
      value: metricValue(spec.metric, spec.exerciseId, days, member, window, nowMs),
      tiebreak: spec.metric === 'count' ? 0 : countIn(days, spec.exerciseId),
    };
  });
  scored.sort((a, b) => {
    if ((a.value === null) !== (b.value === null)) return a.value === null ? 1 : -1;
    if (a.value !== b.value) return (b.value ?? 0) - (a.value ?? 0);
    if (a.tiebreak !== b.tiebreak) return b.tiebreak - a.tiebreak;
    return a.member.name.localeCompare(b.member.name) || (a.member.id < b.member.id ? -1 : a.member.id > b.member.id ? 1 : 0);
  });
  let rank = 0;
  return scored.map((row, i) => {
    const previous = scored[i - 1];
    if (row.value !== null && !(previous && previous.value === row.value && previous.tiebreak === row.tiebreak)) rank = i + 1;
    return { id: row.member.id, name: row.member.name, value: row.value, rank: row.value === null ? null : rank };
  });
}

/** A challenge's collective number: every member's count of its exercise over its window, summed. */
export function groupTotal(exerciseId: string, window: { fromDay: string; toDay: string }, members: BoardMember[]): number {
  return members.reduce((total, member) => total + countIn(daysInWindow(member, window), exerciseId), 0);
}
