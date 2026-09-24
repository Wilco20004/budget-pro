import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { PeriodPicker, usePeriod } from '../components/PeriodContext';
import TrendChart from '../components/TrendChart';
import { money } from '../format';
import { CategoryKpi, PeriodKpis, TrendPoint } from '../types';

function Bullet({ c, fraction }: { c: CategoryKpi; fraction: number }) {
  const scale = Math.max(c.planned, c.actual, 1);
  const pct = (v: number) => `${Math.min(100, (v / scale) * 100)}%`;
  const cls = c.status === 'over' ? 'over' : c.status === 'ahead_of_pace' ? 'ahead' : '';
  const note =
    c.status === 'over'
      ? { text: `⚠ Over by ${money(-c.remaining)}`, color: 'var(--critical-text)' }
      : c.status === 'ahead_of_pace'
        ? { text: '▲ Ahead of pace', color: 'var(--warning-text)' }
        : c.status === 'unplanned'
          ? { text: 'Not budgeted', color: 'var(--muted)' }
          : c.planned
            ? { text: `${money(c.remaining)} left`, color: 'var(--ink-2)' }
            : null;
  const link = c.category_id ? `/transactions?category=${c.category_id}` : '/transactions?status=uncategorized';
  return (
    <div className="bullet">
      <Link to={link} className="name" style={{ color: 'var(--ink)', textDecoration: 'none' }} title={c.name}>
        <span className="icon">{c.icon}</span>
        {c.name}
      </Link>
      <div
        className="track"
        title={`Actual ${money(c.actual)} of ${money(c.planned)} planned${c.planned ? ` — on-pace spend by today is ${money(c.pace_expected)}` : ''}`}
      >
        <div className={`fill ${cls}`} style={{ width: pct(c.actual) }} />
        {c.planned > 0 && <div className="plan-mark" style={{ left: `calc(${pct(c.planned)} - 1px)` }} />}
        {c.planned > 0 && fraction > 0 && fraction < 1 && <div className="pace-mark" style={{ left: pct(c.pace_expected) }} />}
      </div>
      <div className="figures">
        {money(c.actual, { whole: true })} <span className="muted">/ {money(c.planned, { whole: true })}</span>
        {note && (
          <div className="status-note" style={{ color: note.color }}>
            {note.text}
          </div>
        )}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { selected } = usePeriod();
  const [k, setK] = useState<PeriodKpis | null>(null);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selected) return;
    setError(null);
    api.kpis(selected.start).then(setK).catch((e) => setError(e.message));
    api.trend(6, selected.start).then(setTrend).catch(() => undefined);
  }, [selected?.start]);

  const t = k?.totals;
  const expenses = k?.categories.filter((c) => c.kind === 'expense' && c.status !== 'no_activity') ?? [];
  const savings = k?.categories.filter((c) => c.kind === 'savings' && c.status !== 'no_activity') ?? [];
  const toDo = k ? k.recon.uncategorized + k.recon.needs_slip : 0;

  return (
    <>
      <div className="page-head">
        <h1>Budget</h1>
        <PeriodPicker />
      </div>
      {error && <div className="error">{error}</div>}
      {k && t && (
        <>
          <p className="muted small" style={{ marginTop: -8 }}>
            {k.period.label} · day {k.elapsed_days} of {k.period.days}
            {k.days_left > 0 ? ` · ${k.days_left} days to payday` : ''}
          </p>

          {toDo > 0 && (
            <div className="notice">
              <strong>{toDo} transaction{toDo === 1 ? '' : 's'} to reconcile</strong> —{' '}
              {k.recon.uncategorized > 0 && (
                <Link to="/transactions?status=uncategorized">{k.recon.uncategorized} uncategorised</Link>
              )}
              {k.recon.uncategorized > 0 && k.recon.needs_slip > 0 && ', '}
              {k.recon.needs_slip > 0 && <Link to="/transactions?status=needs_slip">{k.recon.needs_slip} waiting for a slip</Link>}
            </div>
          )}

          <div className="tiles">
            <div className="tile">
              <div className="label">Spent</div>
              <div className="value">{money(t.expense_actual, { whole: true })}</div>
              <div className="sub">of {money(t.expense_planned, { whole: true })} planned</div>
            </div>
            <div className="tile">
              <div className="label">Left to spend</div>
              <div className="value" style={{ color: t.expense_remaining < 0 ? 'var(--critical-text)' : undefined }}>
                {money(t.expense_remaining, { whole: true })}
              </div>
              <div className="sub">
                {t.daily_allowance !== null ? `${money(t.daily_allowance, { whole: true })} per day` : 'period closed'}
              </div>
            </div>
            <div className="tile">
              <div className="label">Income</div>
              <div className="value">{money(t.income_actual, { whole: true })}</div>
              <div className="sub">of {money(t.income_planned, { whole: true })} expected</div>
            </div>
            <div className="tile">
              <div className="label">Saved</div>
              <div className="value">{money(t.savings_actual, { whole: true })}</div>
              <div className="sub">
                {t.savings_rate !== null ? `${t.savings_rate.toFixed(0)}% of income unspent` : 'no income yet'}
              </div>
            </div>
            <div className="tile">
              <div className="label">Net</div>
              <div className="value" style={{ color: t.net < 0 ? 'var(--critical-text)' : 'var(--good-text)' }}>
                {money(t.net, { whole: true, signed: true })}
              </div>
              <div className="sub">income − spending − savings</div>
            </div>
            <div className="tile">
              <div className="label">Reconciled</div>
              <div className="value">
                {k.recon.reconciled}/{k.recon.total - k.recon.ignored}
              </div>
              <div className="sub">
                {k.recon.slip_coverage !== null ? `${k.recon.slip_coverage.toFixed(0)}% slips attached` : 'no slip categories used'}
              </div>
            </div>
          </div>

          {t.unallocated < 0 && (
            <div className="notice">
              ⚠ The plan for this period spends {money(-t.unallocated)} more than the expected income.{' '}
              <Link to="/budget">Adjust the budget</Link>
            </div>
          )}

          <div className="card">
            <div className="row" style={{ marginBottom: '0.5rem' }}>
              <h2 style={{ margin: 0 }}>Planned vs actual</h2>
              <span className="spacer" />
              <Link to="/budget" className="small">
                Edit budget
              </Link>
            </div>
            <div className="legend">
              <span>
                <span className="swatch" style={{ background: 'var(--series-1)' }} />
                Spent
              </span>
              <span>
                <span className="swatch" style={{ background: 'var(--ink)', width: 2 }} />
                Planned
              </span>
              {k.elapsed_fraction > 0 && k.elapsed_fraction < 1 && (
                <span>
                  <span className="swatch" style={{ borderLeft: '2px dotted var(--ink-2)', width: 2, borderRadius: 0 }} />
                  Where you'd be on pace today
                </span>
              )}
            </div>
            {expenses.length === 0 ? (
              <div className="empty">
                No spending yet. <Link to="/import">Import a statement</Link> or <Link to="/budget">set up the budget</Link>.
              </div>
            ) : (
              <div className="bullets">
                {expenses
                  .slice()
                  .sort((a, b) => b.actual - a.actual)
                  .map((c) => (
                    <Bullet key={c.category_id ?? 'uncat'} c={c} fraction={k.elapsed_fraction} />
                  ))}
              </div>
            )}
            {savings.length > 0 && (
              <>
                <h2 style={{ marginTop: '1.25rem' }}>Savings</h2>
                <div className="bullets">
                  {savings.map((c) => (
                    <Bullet key={c.category_id ?? 's'} c={{ ...c, status: c.status === 'over' ? 'on_track' : c.status }} fraction={k.elapsed_fraction} />
                  ))}
                </div>
              </>
            )}
          </div>

          {trend.length > 1 && (
            <div className="card">
              <h2>Last {trend.length} periods</h2>
              <TrendChart points={trend} />
            </div>
          )}
        </>
      )}
    </>
  );
}
