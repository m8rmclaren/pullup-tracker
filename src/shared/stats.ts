import type { Entry } from './model';
import { addDays, dayDiff, dayKey, startOfWeek } from './time';

export interface DayTotal {
  day: string;
  reps: number;
  sets: number;
}

export function liveEntries(entries: Iterable<Entry>): Entry[] {
  const out: Entry[] = [];
  for (const e of entries) if (!e.deleted) out.push(e);
  return out;
}

export function dailyTotals(entries: Iterable<Entry>): Map<string, DayTotal> {
  const totals = new Map<string, DayTotal>();
  for (const e of entries) {
    if (e.deleted) continue;
    const day = dayKey(e.ts);
    const t = totals.get(day) ?? { day, reps: 0, sets: 0 };
    t.reps += e.reps;
    t.sets += 1;
    totals.set(day, t);
  }
  return totals;
}

/** `n` consecutive days ending at `endDay`, zero-filled, oldest first. */
export function series(totals: Map<string, DayTotal>, endDay: string, n: number): DayTotal[] {
  const out: DayTotal[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const day = addDays(endDay, -i);
    out.push(totals.get(day) ?? { day, reps: 0, sets: 0 });
  }
  return out;
}

/** Trailing mean of `window` days ending at each point (shorter at the start of history). */
export function trailingAverage(totals: Map<string, DayTotal>, days: string[], window: number, firstDay: string | null): (number | null)[] {
  return days.map((day) => {
    if (!firstDay || day < firstDay) return null;
    const span = Math.min(window, dayDiff(firstDay, day) + 1);
    let sum = 0;
    for (let i = 0; i < span; i++) sum += totals.get(addDays(day, -i))?.reps ?? 0;
    return sum / span;
  });
}

export interface Stats {
  today: DayTotal;
  /** Consecutive days with at least one set, ending today (or yesterday, if today has none yet). */
  streak: number;
  /** Consecutive days meeting the goal, by the same rule. */
  goalStreak: number;
  /** Mean daily reps over the last 7 / 30 completed days (excludes today; never counts days before the first set). */
  avg7: number | null;
  avg30: number | null;
  best: DayTotal | null;
  /** Reps this week (Mon–today) vs. last week over the same weekdays. */
  weekToDate: number;
  lastWeekToDate: number;
  lifetimeReps: number;
  lifetimeSets: number;
  activeDays: number;
  avgSetSize30: number | null;
  goalDays30: number;
  firstDay: string | null;
}

export function computeStats(entries: Iterable<Entry>, now: number, goal: number): Stats {
  const totals = dailyTotals(entries);
  const todayKey = dayKey(now);
  const today = totals.get(todayKey) ?? { day: todayKey, reps: 0, sets: 0 };

  let firstDay: string | null = null;
  let best: DayTotal | null = null;
  let lifetimeReps = 0;
  let lifetimeSets = 0;
  for (const t of totals.values()) {
    if (t.day > todayKey) continue;
    if (!firstDay || t.day < firstDay) firstDay = t.day;
    if (!best || t.reps > best.reps || (t.reps === best.reps && t.day > best.day)) best = t;
    lifetimeReps += t.reps;
    lifetimeSets += t.sets;
  }

  const runLength = (ok: (t: DayTotal | undefined) => boolean) => {
    let day = ok(totals.get(todayKey)) ? todayKey : addDays(todayKey, -1);
    let n = 0;
    while (ok(totals.get(day))) {
      n++;
      day = addDays(day, -1);
    }
    return n;
  };

  const completedAvg = (window: number) => {
    if (!firstDay) return null;
    const yesterday = addDays(todayKey, -1);
    const span = Math.min(window, dayDiff(firstDay, yesterday) + 1);
    if (span <= 0) return null;
    let sum = 0;
    for (let i = 0; i < span; i++) sum += totals.get(addDays(yesterday, -i))?.reps ?? 0;
    return sum / span;
  };

  const weekStart = startOfWeek(todayKey);
  const elapsed = dayDiff(weekStart, todayKey);
  let weekToDate = 0;
  let lastWeekToDate = 0;
  for (let i = 0; i <= elapsed; i++) {
    weekToDate += totals.get(addDays(weekStart, i))?.reps ?? 0;
    lastWeekToDate += totals.get(addDays(weekStart, i - 7))?.reps ?? 0;
  }

  let reps30 = 0;
  let sets30 = 0;
  let goalDays30 = 0;
  for (let i = 0; i < 30; i++) {
    const t = totals.get(addDays(todayKey, -i));
    if (!t) continue;
    reps30 += t.reps;
    sets30 += t.sets;
    if (t.reps >= goal) goalDays30++;
  }

  return {
    today,
    streak: runLength((t) => !!t && t.reps > 0),
    goalStreak: runLength((t) => !!t && t.reps >= goal),
    avg7: completedAvg(7),
    avg30: completedAvg(30),
    best,
    weekToDate,
    lastWeekToDate,
    lifetimeReps,
    lifetimeSets,
    activeDays: [...totals.keys()].filter((d) => d <= todayKey).length,
    avgSetSize30: sets30 ? reps30 / sets30 : null,
    goalDays30,
    firstDay,
  };
}

/** The rep count logged most often in the last 30 days, for highlighting the usual button. */
export function usualReps(entries: Iterable<Entry>, now: number): number | null {
  const cutoff = addDays(dayKey(now), -29);
  const counts = new Map<number, number>();
  for (const e of entries) {
    if (e.deleted || dayKey(e.ts) < cutoff) continue;
    counts.set(e.reps, (counts.get(e.reps) ?? 0) + 1);
  }
  let best: number | null = null;
  let bestN = 0;
  for (const [reps, n] of counts) {
    if (n > bestN || (n === bestN && best !== null && reps > best)) {
      best = reps;
      bestN = n;
    }
  }
  return best;
}

export interface HeaviestSet {
  lbs: number;
  reps: number;
  day: string;
}

/** Most added weight in one set; ties go to more reps, then the more recent day. Null if every set was bodyweight. */
export function heaviestSet(entries: Iterable<Entry>, now: number): HeaviestSet | null {
  const todayKey = dayKey(now);
  let best: HeaviestSet | null = null;
  for (const e of entries) {
    if (e.deleted || !e.lbs) continue;
    const day = dayKey(e.ts);
    if (day > todayKey) continue;
    if (!best || e.lbs > best.lbs || (e.lbs === best.lbs && (e.reps > best.reps || (e.reps === best.reps && day > best.day)))) {
      best = { lbs: e.lbs, reps: e.reps, day };
    }
  }
  return best;
}
