import { useState } from 'react';
import { dayMonth, money } from '../format';
import { TrendPoint } from '../types';

// Income vs spending per period (one money axis), with the planned spend as
// a tick over each spending bar. Hover a period for exact figures.
const W = 640;
const H = 220;
const PAD = { top: 12, right: 8, bottom: 28, left: 56 };

function niceMax(v: number) {
  if (v <= 0) return 1000;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * p;
}

export default function TrendChart({ points }: { points: TrendPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!points.length) return null;
  const max = niceMax(Math.max(...points.map((p) => Math.max(p.income, p.expenses, p.expenses_planned))));
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const band = iw / points.length;
  const barW = Math.min(22, (band - 10) / 2);
  const y = (v: number) => PAD.top + ih - (Math.max(0, v) / max) * ih;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);

  return (
    <div className="chart" onMouseLeave={() => setHover(null)}>
      <div className="legend">
        <span>
          <span className="swatch" style={{ background: 'var(--series-2)' }} />
          Income
        </span>
        <span>
          <span className="swatch" style={{ background: 'var(--series-1)' }} />
          Spending
        </span>
        <span>
          <span className="swatch" style={{ background: 'var(--ink)', height: 2, verticalAlign: 3 }} />
          Planned spending
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Income and spending per budget period">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth={1} />
            <text x={PAD.left - 6} y={y(t) + 4} textAnchor="end" fontSize={10} fill="var(--muted)">
              {money(t, { whole: true }).replace(/^R /, '')}
            </text>
          </g>
        ))}
        {points.map((p, i) => {
          const cx = PAD.left + band * i + band / 2;
          const xi = cx - barW - 1;
          const xe = cx + 1;
          return (
            <g key={p.period.start}>
              {hover === i && <rect x={PAD.left + band * i} y={PAD.top} width={band} height={ih} fill="var(--surface-2)" />}
              <rect x={xi} y={y(p.income)} width={barW} height={Math.max(0, PAD.top + ih - y(p.income))} rx={3} fill="var(--series-2)" />
              <rect x={xe} y={y(p.expenses)} width={barW} height={Math.max(0, PAD.top + ih - y(p.expenses))} rx={3} fill="var(--series-1)" />
              {p.expenses_planned > 0 && (
                <line x1={xe - 3} x2={xe + barW + 3} y1={y(p.expenses_planned)} y2={y(p.expenses_planned)} stroke="var(--ink)" strokeWidth={2} />
              )}
              <text x={cx} y={H - 10} textAnchor="middle" fontSize={10} fill="var(--muted)">
                {dayMonth(p.period.start)}
              </text>
              {/* hit target covers the whole band */}
              <rect
                x={PAD.left + band * i}
                y={PAD.top}
                width={band}
                height={ih}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
                onTouchStart={() => setHover(i)}
              />
            </g>
          );
        })}
        <line x1={PAD.left} x2={W - PAD.right} y1={PAD.top + ih} y2={PAD.top + ih} stroke="var(--line-strong)" />
      </svg>
      {hover !== null && (
        <div
          className="tooltip"
          style={{
            left: `${Math.min(70, ((PAD.left + band * hover + band) / W) * 100)}%`,
            top: 30,
          }}
        >
          <strong>{points[hover].period.label}</strong>
          <div>Income: {money(points[hover].income)}</div>
          <div>Spending: {money(points[hover].expenses)}</div>
          <div>Planned: {money(points[hover].expenses_planned)}</div>
          <div>Saved: {money(points[hover].savings)}</div>
          <div>Net: {money(points[hover].net, { signed: true })}</div>
        </div>
      )}
    </div>
  );
}
