import { useState } from 'preact/hooks';
import type { DayTotal } from '../shared/stats';
import { addDays, dayKey, formatDay, startOfWeek } from '../shared/time';

export function Ring({ value, goal }: { value: number; goal: number }) {
  const r = 88;
  const c = 2 * Math.PI * r;
  const frac = goal > 0 ? Math.min(1, value / goal) : 0;
  const hit = value >= goal && goal > 0;
  return (
    <svg class={`ring${hit ? ' ring--hit' : ''}`} viewBox="0 0 200 200" aria-hidden="true">
      <circle class="ring__track" cx="100" cy="100" r={r} />
      <circle
        class="ring__fill"
        cx="100"
        cy="100"
        r={r}
        stroke-dasharray={`${c * frac} ${c}`}
        transform="rotate(-90 100 100)"
      />
    </svg>
  );
}

interface BarChartProps {
  data: DayTotal[];
  avg: (number | null)[];
  goal: number;
  today: string;
}

/** Daily totals as bars, with the goal as a dashed rule and the 7-day trailing mean as a line. */
export function BarChart({ data, avg, goal, today }: BarChartProps) {
  const [sel, setSel] = useState<number | null>(null);
  const W = 340;
  const H = 168;
  const pad = { l: 26, r: 6, t: 10, b: 20 };
  const max = Math.max(goal * 1.15, ...data.map((d) => d.reps), 10);
  const yMax = Math.ceil(max / 10) * 10;
  const iw = W - pad.l - pad.r;
  const ih = H - pad.t - pad.b;
  const slot = iw / data.length;
  const gap = data.length > 45 ? 1 : 2;
  const bw = Math.max(1, slot - gap);
  const y = (v: number) => pad.t + ih - (v / yMax) * ih;
  const ticks = [0, yMax / 2, yMax];

  const pts = avg
    .map((v, i) => (v === null ? null : `${(pad.l + slot * i + slot / 2).toFixed(1)},${y(v).toFixed(1)}`))
    .filter(Boolean);
  const idx = sel ?? data.length - 1;
  const d = data[idx]!;
  const a = avg[idx];
  const labelEvery = data.length > 45 ? 14 : 7;

  return (
    <div class="chart">
      <div class="chart__readout" aria-live="polite">
        <span class="chart__readout-day">{d.day === today ? 'Today' : formatDay(d.day, { weekday: true })}</span>
        <span class="chart__readout-val">
          <b>{d.reps}</b> reps · {d.sets} {d.sets === 1 ? 'set' : 'sets'}
          {a !== null && a !== undefined ? <span class="muted"> · 7d avg {a.toFixed(1)}</span> : null}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        class="chart__svg"
        role="img"
        aria-label={`Daily reps for the last ${data.length} days`}
        onPointerLeave={() => setSel(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line class="chart__grid" x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} />
            <text class="chart__tick" x={pad.l - 5} y={y(t) + 3} text-anchor="end">
              {t}
            </text>
          </g>
        ))}
        {data.map((day, i) =>
          day.reps > 0 ? (
            <path
              key={day.day}
              class={`chart__bar${i === idx ? ' is-sel' : ''}${day.reps >= goal ? ' is-hit' : ''}`}
              d={roundedTopBar(pad.l + slot * i + gap / 2, y(day.reps), bw, y(0) - y(day.reps), Math.min(4, bw / 2))}
            />
          ) : null,
        )}
        <line class="chart__goal" x1={pad.l} x2={W - pad.r} y1={y(goal)} y2={y(goal)} />
        {pts.length > 1 ? <polyline class="chart__avg" points={pts.join(' ')} /> : null}
        {data.map((day, i) =>
          (data.length - 1 - i) % labelEvery === 0 ? (
            <text key={`l${day.day}`} class="chart__tick" x={pad.l + slot * i + slot / 2} y={H - 5} text-anchor="middle">
              {formatDay(day.day)}
            </text>
          ) : null,
        )}
        {data.map((day, i) => (
          <rect
            key={`h${day.day}`}
            class="chart__hit"
            x={pad.l + slot * i}
            y={pad.t}
            width={slot}
            height={ih}
            onPointerEnter={() => setSel(i)}
            onPointerDown={() => setSel(i)}
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

function roundedTopBar(x: number, y: number, w: number, h: number, r: number): string {
  if (h <= r) return `M${x},${y + h}V${y}H${x + w}V${y + h}Z`;
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/** Bucket thresholds are fractions of the goal so the scale means something regardless of volume. */
export function heatLevel(reps: number, goal: number): 0 | 1 | 2 | 3 | 4 {
  if (reps <= 0) return 0;
  if (reps >= goal) return 4;
  if (reps >= goal * (2 / 3)) return 3;
  if (reps >= goal / 3) return 2;
  return 1;
}

export function Heatmap({ totals, now, goal, weeks = 26 }: { totals: Map<string, DayTotal>; now: number; goal: number; weeks?: number }) {
  const today = dayKey(now);
  const start = addDays(startOfWeek(today), -7 * (weeks - 1));
  const [sel, setSel] = useState<string | null>(null);
  const cols: string[][] = [];
  for (let w = 0; w < weeks; w++) {
    const col: string[] = [];
    for (let d = 0; d < 7; d++) col.push(addDays(start, w * 7 + d));
    cols.push(col);
  }
  const selected = sel ? (totals.get(sel) ?? { day: sel, reps: 0, sets: 0 }) : null;
  const monthLabels = cols.map((col, i) => {
    const first = col[0]!;
    const prev = cols[i - 1]?.[0];
    return !prev || first.slice(5, 7) !== prev.slice(5, 7) ? formatDay(first).split(' ')[0] : '';
  });

  return (
    <div class="heat">
      <div class="heat__months" style={{ gridTemplateColumns: `repeat(${weeks}, 1fr)` }}>
        {monthLabels.map((m, i) => (
          <span key={i}>{m}</span>
        ))}
      </div>
      <div class="heat__grid" style={{ gridTemplateColumns: `repeat(${weeks}, 1fr)` }} role="img" aria-label="Daily reps over the last six months">
        {cols.map((col) =>
          col.map((day) => {
            const t = totals.get(day);
            const future = day > today;
            return (
              <button
                key={day}
                type="button"
                class={`heat__cell lvl${future ? 'x' : heatLevel(t?.reps ?? 0, goal)}${sel === day ? ' is-sel' : ''}${day === today ? ' is-today' : ''}`}
                disabled={future}
                aria-label={`${formatDay(day, { weekday: true })}: ${t?.reps ?? 0} reps`}
                onClick={() => setSel(sel === day ? null : day)}
              />
            );
          }),
        )}
      </div>
      <div class="heat__foot">
        <span class="muted small">
          {selected
            ? `${formatDay(selected.day, { weekday: true })} · ${selected.reps} reps · ${selected.sets} ${selected.sets === 1 ? 'set' : 'sets'}`
            : 'Tap a day for details'}
        </span>
        <span class="heat__scale" aria-hidden="true">
          <span class="small muted">0</span>
          {[1, 2, 3, 4].map((l) => (
            <i key={l} class={`heat__cell lvl${l}`} />
          ))}
          <span class="small muted">{goal}+</span>
        </span>
      </div>
    </div>
  );
}
