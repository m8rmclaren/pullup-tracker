import { useState } from 'preact/hooks';
import type { DayTotal } from '../shared/stats';
import { addDays, dayKey, formatDay, startOfWeek } from '../shared/time';

export function Ring({ value, goal }: { value: number; goal: number }) {
  const radius = 88;
  const circumference = 2 * Math.PI * radius;
  const fractionOfGoal = goal > 0 ? Math.min(1, value / goal) : 0;
  const isGoalHit = value >= goal && goal > 0;
  return (
    <svg class={`ring${isGoalHit ? ' ring--hit' : ''}`} viewBox="0 0 200 200" aria-hidden="true">
      <circle class="ring__track" cx="100" cy="100" r={radius} />
      <circle
        class="ring__fill"
        cx="100"
        cy="100"
        r={radius}
        stroke-dasharray={`${circumference * fractionOfGoal} ${circumference}`}
        transform="rotate(-90 100 100)"
      />
    </svg>
  );
}

interface BarChartProps {
  days: DayTotal[];
  trailingAverages: (number | null)[];
  goal: number;
  today: string;
}

/** Daily totals as bars, with the goal as a dashed rule and the 7-day trailing mean as a line. */
export function BarChart({ days, trailingAverages, goal, today }: BarChartProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const width = 340;
  const height = 168;
  const padding = { left: 26, right: 6, top: 10, bottom: 20 };
  const maxReps = Math.max(goal * 1.15, ...days.map((dayTotal) => dayTotal.reps), 10);
  const yAxisMax = Math.ceil(maxReps / 10) * 10;
  const innerWidth = width - padding.left - padding.right;
  const innerHeight = height - padding.top - padding.bottom;
  const slotWidth = innerWidth / days.length;
  const barGap = days.length > 45 ? 1 : 2;
  const barWidth = Math.max(1, slotWidth - barGap);
  const yForReps = (reps: number) => padding.top + innerHeight - (reps / yAxisMax) * innerHeight;
  const ticks = [0, yAxisMax / 2, yAxisMax];

  const averagePoints = trailingAverages
    .map((average, i) => (average === null ? null : `${(padding.left + slotWidth * i + slotWidth / 2).toFixed(1)},${yForReps(average).toFixed(1)}`))
    .filter(Boolean);
  const selectedIndex = hoveredIndex ?? days.length - 1;
  const selectedDay = days[selectedIndex]!;
  const selectedAverage = trailingAverages[selectedIndex];
  const labelEveryDays = days.length > 45 ? 14 : 7;

  return (
    <div class="chart">
      <div class="chart__readout" aria-live="polite">
        <span class="chart__readout-day">{selectedDay.day === today ? 'Today' : formatDay(selectedDay.day, { weekday: true })}</span>
        <span class="chart__readout-val">
          <b>{selectedDay.reps}</b> reps · {selectedDay.sets} {selectedDay.sets === 1 ? 'set' : 'sets'}
          {selectedAverage !== null && selectedAverage !== undefined ? <span class="muted"> · 7d avg {selectedAverage.toFixed(1)}</span> : null}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        class="chart__svg"
        role="img"
        aria-label={`Daily reps for the last ${days.length} days`}
        onPointerLeave={() => setHoveredIndex(null)}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line class="chart__grid" x1={padding.left} x2={width - padding.right} y1={yForReps(tick)} y2={yForReps(tick)} />
            <text class="chart__tick" x={padding.left - 5} y={yForReps(tick) + 3} text-anchor="end">
              {tick}
            </text>
          </g>
        ))}
        {days.map((dayTotal, i) =>
          dayTotal.reps > 0 ? (
            <path
              key={dayTotal.day}
              class={`chart__bar${i === selectedIndex ? ' is-sel' : ''}${dayTotal.reps >= goal ? ' is-hit' : ''}`}
              d={roundedTopBar(padding.left + slotWidth * i + barGap / 2, yForReps(dayTotal.reps), barWidth, yForReps(0) - yForReps(dayTotal.reps), Math.min(4, barWidth / 2))}
            />
          ) : null,
        )}
        <line class="chart__goal" x1={padding.left} x2={width - padding.right} y1={yForReps(goal)} y2={yForReps(goal)} />
        {averagePoints.length > 1 ? <polyline class="chart__avg" points={averagePoints.join(' ')} /> : null}
        {days.map((dayTotal, i) =>
          (days.length - 1 - i) % labelEveryDays === 0 ? (
            <text key={`l${dayTotal.day}`} class="chart__tick" x={padding.left + slotWidth * i + slotWidth / 2} y={height - 5} text-anchor="middle">
              {formatDay(dayTotal.day)}
            </text>
          ) : null,
        )}
        {days.map((dayTotal, i) => (
          <rect
            key={`h${dayTotal.day}`}
            class="chart__hit"
            x={padding.left + slotWidth * i}
            y={padding.top}
            width={slotWidth}
            height={innerHeight}
            onPointerEnter={() => setHoveredIndex(i)}
            onPointerDown={() => setHoveredIndex(i)}
          />
        ))}
      </svg>
      <div class="legend">
        <span class="legend__item">
          <i class="legend__swatch legend__swatch--bar" /> Daily total
        </span>
        <span class="legend__item">
          <i class="legend__swatch legend__swatch--avg" /> 7-day avg
        </span>
        <span class="legend__item">
          <i class="legend__swatch legend__swatch--goal" /> Goal {goal}
        </span>
      </div>
    </div>
  );
}

function roundedTopBar(x: number, y: number, width: number, height: number, radius: number): string {
  if (height <= radius) return `M${x},${y + height}V${y}H${x + width}V${y + height}Z`;
  return `M${x},${y + height}V${y + radius}Q${x},${y} ${x + radius},${y}H${x + width - radius}Q${x + width},${y} ${x + width},${y + radius}V${y + height}Z`;
}

/** Bucket thresholds are fractions of the goal so the scale means something regardless of volume. */
export function heatLevel(reps: number, goal: number): 0 | 1 | 2 | 3 | 4 {
  if (reps <= 0) return 0;
  if (reps >= goal) return 4;
  if (reps >= goal * (2 / 3)) return 3;
  if (reps >= goal / 3) return 2;
  return 1;
}

export function Heatmap({ dayTotals, now, goal, weeks = 26 }: { dayTotals: Map<string, DayTotal>; now: number; goal: number; weeks?: number }) {
  const today = dayKey(now);
  const firstDay = addDays(startOfWeek(today), -7 * (weeks - 1));
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const weekColumns: string[][] = [];
  for (let week = 0; week < weeks; week++) {
    const weekDays: string[] = [];
    for (let weekday = 0; weekday < 7; weekday++) weekDays.push(addDays(firstDay, week * 7 + weekday));
    weekColumns.push(weekDays);
  }
  const selectedTotal = selectedDay ? (dayTotals.get(selectedDay) ?? { day: selectedDay, reps: 0, sets: 0 }) : null;
  const monthLabels = weekColumns.map((weekDays, i) => {
    const weekStart = weekDays[0]!;
    const previousWeekStart = weekColumns[i - 1]?.[0];
    return !previousWeekStart || weekStart.slice(5, 7) !== previousWeekStart.slice(5, 7) ? formatDay(weekStart).split(' ')[0] : '';
  });

  return (
    <div class="heat">
      <div class="heat__months" style={{ gridTemplateColumns: `repeat(${weeks}, 1fr)` }}>
        {monthLabels.map((monthLabel, i) => (
          <span key={i}>{monthLabel}</span>
        ))}
      </div>
      <div class="heat__grid" style={{ gridTemplateColumns: `repeat(${weeks}, 1fr)` }} role="img" aria-label="Daily reps over the last six months">
        {weekColumns.map((weekDays) =>
          weekDays.map((day) => {
            const dayTotal = dayTotals.get(day);
            const isFuture = day > today;
            return (
              <button
                key={day}
                type="button"
                class={`heat__cell lvl${isFuture ? 'x' : heatLevel(dayTotal?.reps ?? 0, goal)}${selectedDay === day ? ' is-sel' : ''}${day === today ? ' is-today' : ''}`}
                disabled={isFuture}
                aria-label={`${formatDay(day, { weekday: true })}: ${dayTotal?.reps ?? 0} reps`}
                onClick={() => setSelectedDay(selectedDay === day ? null : day)}
              />
            );
          }),
        )}
      </div>
      <div class="heat__foot">
        <span class="muted small">
          {selectedTotal
            ? `${formatDay(selectedTotal.day, { weekday: true })} · ${selectedTotal.reps} reps · ${selectedTotal.sets} ${selectedTotal.sets === 1 ? 'set' : 'sets'}`
            : 'Tap a day for details'}
        </span>
        <span class="heat__scale" aria-hidden="true">
          <span class="small muted">0</span>
          {[1, 2, 3, 4].map((level) => (
            <i key={level} class={`heat__cell lvl${level}`} />
          ))}
          <span class="small muted">{goal}+</span>
        </span>
      </div>
    </div>
  );
}
