import { useState } from 'preact/hooks';
import type { Entry } from '../shared/model';
import { type Stats, dailyTotals, heaviestSet, series, trailingAverage } from '../shared/stats';
import { addDays, dayKey, formatDay } from '../shared/time';
import { BarChart, Heatmap } from './charts';

interface TrendsProps {
  entries: Entry[];
  stats: Stats;
  now: number;
  goal: number;
  onOpenDay: (day: string) => void;
}

const fmt1 = (n: number | null) => (n === null ? '—' : n.toFixed(n >= 100 ? 0 : 1));

export function Trends({ entries, stats, now, goal, onOpenDay }: TrendsProps) {
  const [range, setRange] = useState<30 | 90>(30);
  const today = dayKey(now);
  const totals = dailyTotals(entries);
  const data = series(totals, today, range);
  const avg = trailingAverage(totals, data.map((d) => d.day), 7, stats.firstDay);
  const delta = stats.weekToDate - stats.lastWeekToDate;
  const history = series(totals, today, 30).reverse();
  const histMax = Math.max(goal, ...history.map((d) => d.reps));
  const heaviest = heaviestSet(entries, now);

  return (
    <div class="trends">
      <div class="tiles">
        <Tile label="Streak" value={`${stats.streak}`} unit={stats.streak === 1 ? 'day' : 'days'} note={`${stats.goalStreak} at goal`} />
        <Tile label="7-day avg" value={fmt1(stats.avg7)} unit="/day" note={`30-day ${fmt1(stats.avg30)}`} />
        <Tile
          label="This week"
          value={`${stats.weekToDate}`}
          unit="reps"
          note={stats.lastWeekToDate || stats.weekToDate ? `${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta)} vs last week` : 'Mon–today'}
        />
        <Tile label="Best day" value={stats.best ? `${stats.best.reps}` : '—'} unit="reps" note={stats.best ? formatDay(stats.best.day, { year: stats.best.day.slice(0, 4) !== today.slice(0, 4) }) : 'No sets yet'} />
        <Tile label="Avg set" value={fmt1(stats.avgSetSize30)} unit="reps" note="last 30 days" />
        <Tile label="Goal days" value={`${stats.goalDays30}`} unit="/ 30" note={`goal ${goal}`} />
        {heaviest ? (
          <Tile
            label="Heaviest set"
            value={`+${heaviest.lbs}`}
            unit={`lb × ${heaviest.reps}`}
            note={formatDay(heaviest.day, { year: heaviest.day.slice(0, 4) !== today.slice(0, 4) })}
            wide
          />
        ) : null}
        <Tile label="Lifetime" value={stats.lifetimeReps.toLocaleString()} unit="reps" note={`${stats.lifetimeSets.toLocaleString()} sets · ${stats.activeDays} days`} wide />
      </div>

      <section class="card">
        <header class="card__head">
          <h2>Daily reps</h2>
          <div class="seg" role="tablist" aria-label="Range">
            {([30, 90] as const).map((r) => (
              <button key={r} type="button" role="tab" aria-selected={range === r} class={range === r ? 'is-on' : ''} onClick={() => setRange(r)}>
                {r}D
              </button>
            ))}
          </div>
        </header>
        <BarChart key={range} data={data} avg={avg} goal={goal} today={today} />
      </section>

      <section class="card">
        <header class="card__head">
          <h2>Last 6 months</h2>
        </header>
        <Heatmap totals={totals} now={now} goal={goal} />
      </section>

      <section class="card">
        <header class="card__head">
          <h2>History</h2>
          <span class="muted small">tap a day to edit</span>
        </header>
        <ul class="history">
          {history.map((d) => (
            <li key={d.day}>
              <button type="button" class="history__row" onClick={() => onOpenDay(d.day)}>
                <span class="history__day">{d.day === today ? 'Today' : d.day === addDays(today, -1) ? 'Yesterday' : formatDay(d.day, { weekday: true })}</span>
                <span class="history__bar" aria-hidden="true">
                  <i style={{ width: `${(d.reps / histMax) * 100}%` }} class={d.reps >= goal ? 'is-hit' : ''} />
                </span>
                <span class="history__reps">{d.reps}</span>
                <span class="history__sets muted">{d.sets ? `${d.sets}×` : ''}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Tile({ label, value, unit, note, wide }: { label: string; value: string; unit: string; note: string; wide?: boolean }) {
  return (
    <div class={`tile${wide ? ' tile--wide' : ''}`}>
      <div class="tile__label">{label}</div>
      <div class="tile__value">
        {value} <span class="tile__unit">{unit}</span>
      </div>
      <div class="tile__note">{note}</div>
    </div>
  );
}
