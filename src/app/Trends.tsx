import { useState } from 'preact/hooks';
import type { Entry } from '../shared/model';
import { type Stats, dailyTotals, dailySeries, heaviestSet, trailingAverage } from '../shared/stats';
import { addDays, dayKey, formatDay } from '../shared/time';
import { BarChart, Heatmap } from './charts';

interface TrendsProps {
  entries: Entry[];
  stats: Stats;
  now: number;
  goal: number;
  onOpenDay: (day: string) => void;
}

const formatOneDecimal = (value: number | null) => (value === null ? '—' : value.toFixed(value >= 100 ? 0 : 1));

export function Trends({ entries, stats, now, goal, onOpenDay }: TrendsProps) {
  const [rangeDays, setRangeDays] = useState<30 | 90>(30);
  const today = dayKey(now);
  const dayTotals = dailyTotals(entries);
  const chartDays = dailySeries(dayTotals, today, rangeDays);
  const trailingAverages = trailingAverage(dayTotals, chartDays.map((dayTotal) => dayTotal.day), 7, stats.firstDay);
  const weekOverWeekDelta = stats.weekToDate - stats.lastWeekToDate;
  const historyDays = dailySeries(dayTotals, today, 30).reverse();
  const historyMaxReps = Math.max(goal, ...historyDays.map((dayTotal) => dayTotal.reps));
  const heaviest = heaviestSet(entries, now);

  return (
    <div class="trends">
      <div class="tiles">
        <Tile label="Streak" value={`${stats.streak}`} unit={stats.streak === 1 ? 'day' : 'days'} note={`${stats.goalStreak} at goal`} />
        <Tile label="7-day avg" value={formatOneDecimal(stats.avgDailyReps7Days)} unit="/day" note={`30-day ${formatOneDecimal(stats.avgDailyReps30Days)}`} />
        <Tile
          label="This week"
          value={`${stats.weekToDate}`}
          unit="reps"
          note={stats.lastWeekToDate || stats.weekToDate ? `${weekOverWeekDelta >= 0 ? '▲' : '▼'} ${Math.abs(weekOverWeekDelta)} vs last week` : 'Mon–today'}
        />
        <Tile label="Best day" value={stats.bestDay ? `${stats.bestDay.reps}` : '—'} unit="reps" note={stats.bestDay ? formatDay(stats.bestDay.day, { year: stats.bestDay.day.slice(0, 4) !== today.slice(0, 4) }) : 'No sets yet'} />
        <Tile label="Avg set" value={formatOneDecimal(stats.avgSetReps30Days)} unit="reps" note="last 30 days" />
        <Tile label="Goal days" value={`${stats.goalDaysLast30}`} unit="/ 30" note={`goal ${goal}`} />
        {heaviest ? (
          <Tile
            label="Heaviest set"
            value={`+${heaviest.addedWeightLbs}`}
            unit={`lb × ${heaviest.reps}`}
            note={formatDay(heaviest.day, { year: heaviest.day.slice(0, 4) !== today.slice(0, 4) })}
            isWide
          />
        ) : null}
        <Tile label="Lifetime" value={stats.lifetimeReps.toLocaleString()} unit="reps" note={`${stats.lifetimeSets.toLocaleString()} sets · ${stats.activeDays} days`} isWide />
      </div>

      <section class="card">
        <header class="card__head">
          <h2>Daily reps</h2>
          <div class="seg" role="tablist" aria-label="Range">
            {([30, 90] as const).map((rangeOption) => (
              <button key={rangeOption} type="button" role="tab" aria-selected={rangeDays === rangeOption} class={rangeDays === rangeOption ? 'is-on' : ''} onClick={() => setRangeDays(rangeOption)}>
                {rangeOption}D
              </button>
            ))}
          </div>
        </header>
        <BarChart key={rangeDays} days={chartDays} trailingAverages={trailingAverages} goal={goal} today={today} />
      </section>

      <section class="card">
        <header class="card__head">
          <h2>Last 6 months</h2>
        </header>
        <Heatmap dayTotals={dayTotals} now={now} goal={goal} />
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
                  <i style={{ width: `${(dayTotal.reps / historyMaxReps) * 100}%` }} class={dayTotal.reps >= goal ? 'is-hit' : ''} />
                </span>
                <span class="history__reps">{dayTotal.reps}</span>
                <span class="history__sets muted">{dayTotal.sets ? `${dayTotal.sets}×` : ''}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

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
