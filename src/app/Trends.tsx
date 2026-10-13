import { useMemo, useState } from 'preact/hooks';
import type { Entry } from '../shared/model';
import { recentExerciseIds } from '../shared/pad';
import { type DayTotal, type Stats, type UnitLookup, bestSet, dailyTotals, dailySeries, exerciseDailyTotals, heaviestSet, statsFromTotals, trailingAverage } from '../shared/stats';
import { addDays, dayKey, formatDay } from '../shared/time';
import { formatMetric } from './Board';
import { BarChart, Heatmap } from './charts';
import { exerciseName, formatHoldSeconds } from './labels';
import type { Tracker } from './tracker';

interface TrendsProps {
  tracker: Tracker;
  entries: Entry[];
  unitOf: UnitLookup;
  stats: Stats;
  now: number;
  timeZone: string;
  goal: number;
  onOpenDay: (day: string) => void;
}

const formatOneDecimal = (value: number | null) => (value === null ? '—' : value.toFixed(value >= 100 ? 0 : 1));
const HEATMAP_DAYS = 26 * 7;

/** The ring across exercises, or one exercise in its own unit. */
export function Trends({ tracker, entries, unitOf, stats, now, timeZone, goal, onOpenDay }: TrendsProps) {
  const [exerciseId, setExerciseId] = useState<string | null>(null);
  const exerciseIds = useMemo(() => recentExerciseIds(entries, 100).sort((a, b) => exerciseName(a, tracker).localeCompare(exerciseName(b, tracker))), [entries, tracker]);

  return (
    <div class="trends">
      {exerciseIds.length > 1 || (exerciseIds.length === 1 && exerciseIds[0] !== 'pull-up') ? (
        <label class="field trends__picker">
          <span class="sr-only">Exercise</span>
          <select value={exerciseId ?? ''} onChange={(event) => setExerciseId((event.target as HTMLSelectElement).value || null)}>
            <option value="">All exercises · reps on the ring</option>
            {exerciseIds.map((id) => (
              <option key={id} value={id}>
                {exerciseName(id, tracker)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {exerciseId ? (
        <ExerciseTrends key={exerciseId} tracker={tracker} entries={entries} exerciseId={exerciseId} now={now} timeZone={timeZone} onOpenDay={onOpenDay} />
      ) : (
        <RingTrends entries={entries} unitOf={unitOf} stats={stats} now={now} timeZone={timeZone} goal={goal} onOpenDay={onOpenDay} />
      )}
    </div>
  );
}

function RingTrends({ entries, unitOf, stats, now, timeZone, goal, onOpenDay }: Omit<TrendsProps, 'tracker'>) {
  const today = dayKey(now, timeZone);
  const dayTotals = dailyTotals(entries, timeZone, unitOf);
  const weekOverWeekDelta = stats.weekToDate - stats.lastWeekToDate;
  const heaviest = heaviestSet(entries, now, timeZone);

  return (
    <>
      <div class="tiles">
        <Tile label="Streak" value={`${stats.streak}`} unit={stats.streak === 1 ? 'day' : 'days'} note={`${stats.goalStreak} at goal`} />
        <Tile label="7-day avg" value={formatOneDecimal(stats.avgDailyReps7Days)} unit="/day" note={`30-day ${formatOneDecimal(stats.avgDailyReps30Days)}`} />
        <Tile
          label="This week"
          value={`${stats.weekToDate}`}
          unit="reps"
          note={stats.lastWeekToDate || stats.weekToDate ? `${weekOverWeekDelta >= 0 ? '▲' : '▼'} ${Math.abs(weekOverWeekDelta)} vs last week` : 'Mon–today'}
        />
        <Tile label="Best day" value={stats.bestDay ? `${stats.bestDay.reps}` : '—'} unit="reps" note={stats.bestDay ? dayLabel(stats.bestDay.day, today) : 'No sets yet'} />
        <Tile label="Avg set" value={formatOneDecimal(stats.avgSetReps30Days)} unit="reps" note="last 30 days" />
        <Tile label="Goal days" value={`${stats.goalDaysLast30}`} unit="/ 30" note={`goal ${goal}`} />
        {heaviest ? <Tile label="Heaviest pull-up" value={`+${heaviest.addedWeightLbs}`} unit={`lb × ${heaviest.reps}`} note={dayLabel(heaviest.day, today)} isWide /> : null}
        <Tile label="Lifetime" value={stats.lifetimeReps.toLocaleString()} unit="reps" note={`${stats.lifetimeSets.toLocaleString()} sets · ${stats.activeDays} days`} isWide />
      </div>
      <Charts dayTotals={dayTotals} firstDay={stats.firstDay} goal={goal} heatScale={goal} now={now} timeZone={timeZone} title="Daily reps" onOpenDay={onOpenDay} />
    </>
  );
}

function ExerciseTrends({ tracker, entries, exerciseId, now, timeZone, onOpenDay }: { tracker: Tracker; entries: Entry[]; exerciseId: string; now: number; timeZone: string; onOpenDay: (day: string) => void }) {
  const today = dayKey(now, timeZone);
  const exercise = tracker.exercise(exerciseId);
  const isTimed = exercise?.measure === 'time';
  const unit = isTimed ? '' : `${exercise?.unit ?? 'rep'}s`;
  const formatAmount = (amount: number) => formatMetric('count', Math.round(amount), exercise);
  const formatNumber = (amount: number | null) => (amount === null ? '—' : isTimed ? formatHoldSeconds(Math.round(amount)) : formatOneDecimal(amount));
  const dayTotals = exerciseDailyTotals(entries, timeZone, exerciseId);
  const stats = statsFromTotals(dayTotals, now, 0, timeZone);
  const best = bestSet(entries, now, timeZone, exerciseId);
  const heaviest = heaviestSet(entries, now, timeZone, exerciseId);
  const weekOverWeekDelta = stats.weekToDate - stats.lastWeekToDate;
  let heatScale = 1;
  for (let i = 0; i < HEATMAP_DAYS; i++) heatScale = Math.max(heatScale, dayTotals.get(addDays(today, -i))?.reps ?? 0);

  return (
    <>
      <div class="tiles">
        <Tile label="Today" value={isTimed ? formatHoldSeconds(stats.today.reps) : `${stats.today.reps}`} unit={unit} note={`${stats.today.sets} ${stats.today.sets === 1 ? 'set' : 'sets'}`} />
        <Tile label="Streak" value={`${stats.streak}`} unit={stats.streak === 1 ? 'day' : 'days'} note={`${stats.activeDays} days in all`} />
        <Tile
          label="This week"
          value={isTimed ? formatHoldSeconds(stats.weekToDate) : `${stats.weekToDate}`}
          unit={unit}
          note={stats.lastWeekToDate || stats.weekToDate ? `${weekOverWeekDelta >= 0 ? '▲' : '▼'} ${isTimed ? formatHoldSeconds(Math.abs(weekOverWeekDelta)) : Math.abs(weekOverWeekDelta)} vs last week` : 'Mon–today'}
        />
        <Tile label="7-day avg" value={formatNumber(stats.avgDailyReps7Days)} unit="/day" note={`30-day ${formatNumber(stats.avgDailyReps30Days)}`} />
        <Tile label="Best day" value={stats.bestDay ? (isTimed ? formatHoldSeconds(stats.bestDay.reps) : `${stats.bestDay.reps}`) : '—'} unit={unit} note={stats.bestDay ? dayLabel(stats.bestDay.day, today) : 'No sets yet'} />
        <Tile label="Best set" value={best ? (isTimed ? formatHoldSeconds(best.amount) : `${best.amount}`) : '—'} unit={unit} note={best ? dayLabel(best.day, today) : 'No sets yet'} />
        <Tile label="Avg set" value={formatNumber(stats.avgSetReps30Days)} unit={unit} note="last 30 days" />
        {heaviest ? <Tile label="Heaviest set" value={`+${heaviest.addedWeightLbs}`} unit={`lb × ${isTimed ? formatHoldSeconds(heaviest.reps) : heaviest.reps}`} note={dayLabel(heaviest.day, today)} /> : null}
        <Tile label="Lifetime" value={isTimed ? formatHoldSeconds(stats.lifetimeReps) : stats.lifetimeReps.toLocaleString()} unit={unit} note={`${stats.lifetimeSets.toLocaleString()} sets · ${stats.activeDays} days`} isWide />
      </div>
      <Charts dayTotals={dayTotals} firstDay={stats.firstDay} goal={null} heatScale={heatScale} now={now} timeZone={timeZone} title={`Daily ${isTimed ? 'time' : unit}`} formatAmount={formatAmount} onOpenDay={onOpenDay} />
    </>
  );
}

interface ChartsProps {
  dayTotals: Map<string, DayTotal>;
  firstDay: string | null;
  goal: number | null;
  heatScale: number;
  now: number;
  timeZone: string;
  title: string;
  formatAmount?: (amount: number) => string;
  onOpenDay: (day: string) => void;
}

function Charts({ dayTotals, firstDay, goal, heatScale, now, timeZone, title, formatAmount, onOpenDay }: ChartsProps) {
  const [rangeDays, setRangeDays] = useState<30 | 90>(30);
  const today = dayKey(now, timeZone);
  const chartDays = dailySeries(dayTotals, today, rangeDays);
  const trailingAverages = trailingAverage(dayTotals, chartDays.map((dayTotal) => dayTotal.day), 7, firstDay);
  const historyDays = dailySeries(dayTotals, today, 30).reverse();
  const historyMax = Math.max(goal ?? 1, ...historyDays.map((dayTotal) => dayTotal.reps));

  return (
    <>
      <section class="card">
        <header class="card__head">
          <h2>{title}</h2>
          <div class="seg" role="tablist" aria-label="Range">
            {([30, 90] as const).map((rangeOption) => (
              <button key={rangeOption} type="button" role="tab" aria-selected={rangeDays === rangeOption} class={rangeDays === rangeOption ? 'is-on' : ''} onClick={() => setRangeDays(rangeOption)}>
                {rangeOption}D
              </button>
            ))}
          </div>
        </header>
        <BarChart key={rangeDays} days={chartDays} trailingAverages={trailingAverages} goal={goal} today={today} formatAmount={formatAmount} />
      </section>

      <section class="card">
        <header class="card__head">
          <h2>Last 6 months</h2>
        </header>
        <Heatmap dayTotals={dayTotals} today={today} goal={heatScale} formatAmount={formatAmount} />
      </section>

      <section class="card">
        <header class="card__head">
          <h2>History</h2>
          <span class="muted small">tap a day to edit</span>
        </header>
        <ul class="history">
          {historyDays.map((dayTotal) => (
            <li key={dayTotal.day}>
              <button type="button" class="history__row" onClick={() => onOpenDay(dayTotal.day)}>
                <span class="history__day">{dayTotal.day === today ? 'Today' : dayTotal.day === addDays(today, -1) ? 'Yesterday' : formatDay(dayTotal.day, { weekday: true })}</span>
                <span class="history__bar" aria-hidden="true">
                  <i style={{ width: `${(dayTotal.reps / historyMax) * 100}%` }} class={goal !== null && dayTotal.reps >= goal ? 'is-hit' : ''} />
                </span>
                <span class="history__reps">{formatAmount && dayTotal.reps ? formatAmount(dayTotal.reps) : dayTotal.reps}</span>
                <span class="history__sets muted">{dayTotal.sets ? `${dayTotal.sets}×` : ''}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

const dayLabel = (day: string, today: string) => formatDay(day, { year: day.slice(0, 4) !== today.slice(0, 4) });

function Tile({ label, value, unit, note, isWide }: { label: string; value: string; unit: string; note: string; isWide?: boolean }) {
  return (
    <div class={`tile${isWide ? ' tile--wide' : ''}`}>
      <div class="tile__label">{label}</div>
      <div class="tile__value">
        {value} <span class="tile__unit">{unit}</span>
      </div>
      <div class="tile__note">{note}</div>
    </div>
  );
}
