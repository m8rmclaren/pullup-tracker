import type { Entry } from './model';
import { addDays, dayKey, daysBetween, startOfWeek } from './time';

export interface DayTotal {
  day: string;
  reps: number;
  sets: number;
}

export function liveEntries(entries: Iterable<Entry>): Entry[] {
  const undeleted: Entry[] = [];
  for (const entry of entries) if (!entry.deleted) undeleted.push(entry);
  return undeleted;
}

export function dailyTotals(entries: Iterable<Entry>): Map<string, DayTotal> {
  const totals = new Map<string, DayTotal>();
  for (const entry of entries) {
    if (entry.deleted) continue;
    const day = dayKey(entry.doneAt);
    const dayTotal = totals.get(day) ?? { day, reps: 0, sets: 0 };
    dayTotal.reps += entry.reps;
    dayTotal.sets += 1;
    totals.set(day, dayTotal);
  }
  return totals;
}

/** `dayCount` consecutive days ending at `endDay`, zero-filled, oldest first. */
export function dailySeries(totals: Map<string, DayTotal>, endDay: string, dayCount: number): DayTotal[] {
  const dayTotals: DayTotal[] = [];
  for (let i = dayCount - 1; i >= 0; i--) {
    const day = addDays(endDay, -i);
    dayTotals.push(totals.get(day) ?? { day, reps: 0, sets: 0 });
  }
  return dayTotals;
}

/** Trailing mean of `windowDays` days ending at each point (shorter at the start of history). */
export function trailingAverage(totals: Map<string, DayTotal>, days: string[], windowDays: number, firstDay: string | null): (number | null)[] {
  return days.map((day) => {
    if (!firstDay || day < firstDay) return null;
    const spanDays = Math.min(windowDays, daysBetween(firstDay, day) + 1);
    let sum = 0;
    for (let i = 0; i < spanDays; i++) sum += totals.get(addDays(day, -i))?.reps ?? 0;
    return sum / spanDays;
  });
}

export interface Stats {
  today: DayTotal;
  /** Consecutive days with at least one set, ending today (or yesterday, if today has none yet). */
  streak: number;
  /** Consecutive days meeting the goal, by the same rule. */
  goalStreak: number;
  /** Mean daily reps over the last 7 / 30 completed days (excludes today; never counts days before the first set). */
  avgDailyReps7Days: number | null;
  avgDailyReps30Days: number | null;
  bestDay: DayTotal | null;
  /** Reps this week (Mon–today) vs. last week over the same weekdays. */
  weekToDate: number;
  lastWeekToDate: number;
  lifetimeReps: number;
  lifetimeSets: number;
  activeDays: number;
  avgSetReps30Days: number | null;
  goalDaysLast30: number;
  firstDay: string | null;
}

export function computeStats(entries: Iterable<Entry>, nowMs: number, goalReps: number): Stats {
  const totals = dailyTotals(entries);
  const todayKey = dayKey(nowMs);
  const today = totals.get(todayKey) ?? { day: todayKey, reps: 0, sets: 0 };

  let firstDay: string | null = null;
  let bestDay: DayTotal | null = null;
  let lifetimeReps = 0;
  let lifetimeSets = 0;
  for (const dayTotal of totals.values()) {
    if (dayTotal.day > todayKey) continue;
    if (!firstDay || dayTotal.day < firstDay) firstDay = dayTotal.day;
    if (!bestDay || dayTotal.reps > bestDay.reps || (dayTotal.reps === bestDay.reps && dayTotal.day > bestDay.day)) bestDay = dayTotal;
    lifetimeReps += dayTotal.reps;
    lifetimeSets += dayTotal.sets;
  }

  const runLength = (isCounted: (dayTotal: DayTotal | undefined) => boolean) => {
    let day = isCounted(totals.get(todayKey)) ? todayKey : addDays(todayKey, -1);
    let runDays = 0;
    while (isCounted(totals.get(day))) {
      runDays++;
      day = addDays(day, -1);
    }
    return runDays;
  };

  const completedAvg = (windowDays: number) => {
    if (!firstDay) return null;
    const yesterday = addDays(todayKey, -1);
    const spanDays = Math.min(windowDays, daysBetween(firstDay, yesterday) + 1);
    if (spanDays <= 0) return null;
    let sum = 0;
    for (let i = 0; i < spanDays; i++) sum += totals.get(addDays(yesterday, -i))?.reps ?? 0;
    return sum / spanDays;
  };

  const weekStart = startOfWeek(todayKey);
  const elapsedDays = daysBetween(weekStart, todayKey);
  let weekToDate = 0;
  let lastWeekToDate = 0;
  for (let i = 0; i <= elapsedDays; i++) {
    weekToDate += totals.get(addDays(weekStart, i))?.reps ?? 0;
    lastWeekToDate += totals.get(addDays(weekStart, i - 7))?.reps ?? 0;
  }

  let repsLast30 = 0;
  let setsLast30 = 0;
  let goalDaysLast30 = 0;
  for (let i = 0; i < 30; i++) {
    const dayTotal = totals.get(addDays(todayKey, -i));
    if (!dayTotal) continue;
    repsLast30 += dayTotal.reps;
    setsLast30 += dayTotal.sets;
    if (dayTotal.reps >= goalReps) goalDaysLast30++;
  }

  return {
    today,
    streak: runLength((dayTotal) => !!dayTotal && dayTotal.reps > 0),
    goalStreak: runLength((dayTotal) => !!dayTotal && dayTotal.reps >= goalReps),
    avgDailyReps7Days: completedAvg(7),
    avgDailyReps30Days: completedAvg(30),
    bestDay,
    weekToDate,
    lastWeekToDate,
    lifetimeReps,
    lifetimeSets,
    activeDays: [...totals.keys()].filter((day) => day <= todayKey).length,
    avgSetReps30Days: setsLast30 ? repsLast30 / setsLast30 : null,
    goalDaysLast30,
    firstDay,
  };
}

/** The rep count logged most often in the last 30 days, for highlighting the usual button. */
export function usualReps(entries: Iterable<Entry>, nowMs: number): number | null {
  const cutoff = addDays(dayKey(nowMs), -29);
  const setCountsByReps = new Map<number, number>();
  for (const entry of entries) {
    if (entry.deleted || dayKey(entry.doneAt) < cutoff) continue;
    setCountsByReps.set(entry.reps, (setCountsByReps.get(entry.reps) ?? 0) + 1);
  }
  let mostCommonReps: number | null = null;
  let mostCommonCount = 0;
  for (const [reps, setCount] of setCountsByReps) {
    if (setCount > mostCommonCount || (setCount === mostCommonCount && mostCommonReps !== null && reps > mostCommonReps)) {
      mostCommonReps = reps;
      mostCommonCount = setCount;
    }
  }
  return mostCommonReps;
}

export interface HeaviestSet {
  addedWeightLbs: number;
  reps: number;
  day: string;
}

/** Most added weight in one set; ties go to more reps, then the more recent day. Null if every set was bodyweight. */
export function heaviestSet(entries: Iterable<Entry>, nowMs: number): HeaviestSet | null {
  const todayKey = dayKey(nowMs);
  let heaviest: HeaviestSet | null = null;
  for (const entry of entries) {
    if (entry.deleted || !entry.addedWeightLbs) continue;
    const day = dayKey(entry.doneAt);
    if (day > todayKey) continue;
    if (!heaviest || entry.addedWeightLbs > heaviest.addedWeightLbs || (entry.addedWeightLbs === heaviest.addedWeightLbs && (entry.reps > heaviest.reps || (entry.reps === heaviest.reps && day > heaviest.day)))) {
      heaviest = { addedWeightLbs: entry.addedWeightLbs, reps: entry.reps, day };
    }
  }
  return heaviest;
}
