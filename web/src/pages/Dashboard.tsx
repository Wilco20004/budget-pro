import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { PeriodPicker, usePeriod } from '../components/PeriodContext';
import TrendChart from '../components/TrendChart';
import { money, shortDate } from '../format';
import { CategoryKpi, GroupKpi, PeriodKpis, SavingsOverview, TrendPoint } from '../types';

/** A group's subtotal bar, followed by its categories. */
/** A category's bar, then its subcategories' bars indented under it. */
function WithChildren({ c, all, fraction }: { c: CategoryKpi; all: CategoryKpi[]; fraction: number }) {
  const kids = all.filter((x) => x.parent_id && x.parent_id === c.category_id && x.status !== 'no_activity').sort((a, b) => b.actual - a.actual);
  return (
    <>
      <Bullet c={c} fraction={fraction} />
      {kids.length > 0 && (
        <div className="bullets sub-bullets">
          {kids.map((x) => (
            <Bullet key={x.category_id} c={x} fraction={fraction} parent={c} />
          ))}
          {(c.own_actual ?? 0) > 0 && (
            <div className="small muted">Not split further: {money(c.own_actual ?? 0, { whole: true })}</div>
          )}
        </div>
      )}
    </>
  );
}

function GroupBlock({ g, members, all, fraction }: { g: GroupKpi; members: CategoryKpi[]; all: CategoryKpi[]; fraction: number }) {
  const shown = members.filter((c) => c.status !== 'no_activity').sort((a, b) => b.actual - a.actual);
  if (!shown.length && !g.planned) return null;
  const asKpi: CategoryKpi = {
    category_id: null,
    name: g.name,
    kind: 'expense',
    color: null,
    icon: null,
    requires_slip: false,
    planned: g.planned,
    actual: g.actual,
    remaining: g.remaining,
    pct_used: g.pct_used,
    pace_expected: g.pace_expected,
    projected: g.actual,
    status: g.status,
    transaction_count: 0,
    group_id: g.group_id,
    group_name: g.name,
    parent_id: null,
    personal: false,
    plans_planned: members.reduce((a, c) => a + c.plans_planned, 0),
    goals_planned: 0,
  };
  return (
    <div className="group-block">
      <Bullet c={asKpi} fraction={fraction} header />
      <div className="bullets group-members">
        {shown.map((c) => (
          <WithChildren key={c.category_id ?? 'uncat'} c={c} all={all} fraction={fraction} />
        ))}
      </div>
    </div>
  );
}

function Bullet({ c, fraction, header = false, parent }: { c: CategoryKpi; fraction: number; header?: boolean; parent?: CategoryKpi }) {
  // A subcategory without its own budget is drawn against its parent's, as a share of it.
  const share = parent && !c.planned;
  const scale = share ? Math.max(parent.planned, parent.actual, 1) : Math.max(c.planned, c.actual, 1);
  const pct = (v: number) => `${Math.min(100, (v / scale) * 100)}%`;
  const cls = c.status === 'over' ? 'over' : c.status === 'ahead_of_pace' ? 'ahead' : '';
  const note =
    c.status === 'over'
      ? { text: `⚠ Over by ${money(-c.remaining)}`, color: 'var(--critical-text)' }
      : c.status === 'ahead_of_pace'
        ? { text: '▲ Ahead of pace', color: 'var(--warning-text)' }
        : share && parent
          ? { text: `part of ${parent.name}`, color: 'var(--muted)' }
          : c.status === 'unplanned'
            ? { text: 'Not budgeted', color: 'var(--muted)' }
          : c.planned
            ? { text: `${money(c.remaining)} left`, color: 'var(--ink-2)' }
            : null;
  const link = c.category_id ? `/transactions?category=${c.category_id}` : '/transactions?status=uncategorized';
  return (
    <div className={`bullet${header ? ' group-head' : ''}`}>
      {header ? (
        <span className="name" title={c.name}>
          {c.name}
        </span>
      ) : (
        <Link to={link} className="name" style={{ color: 'var(--ink)', textDecoration: 'none' }} title={c.name}>
          <span className="icon">{c.icon}</span>
          {c.name}
        </Link>
      )}
      <div
        className="track"
        title={`Actual ${money(c.actual)} of ${money(c.planned)} planned${c.plans_planned ? ` (incl. ${money(c.plans_planned)} payment plans)` : ''}${c.goals_planned ? ` (incl. ${money(c.goals_planned)} savings goal top-ups)` : ''}${c.planned ? ` — on-pace spend by today is ${money(c.pace_expected)}` : ''}`}
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
  const [goalsOverview, setGoalsOverview] = useState<SavingsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!selected) return;
    setError(null);
    api.kpis(selected.start).then(setK).catch((e) => setError(e.message));
    api.trend(6, selected.start).then(setTrend).catch(() => undefined);
    api.savings(selected.start).then(setGoalsOverview).catch(() => undefined);
  }, [selected?.start]);

  const t = k?.totals;
  const expenses = k?.categories.filter((c) => c.kind === 'expense' && !c.parent_id && c.status !== 'no_activity') ?? [];
  const savings = k?.categories.filter((c) => c.kind === 'savings' && !c.parent_id && c.status !== 'no_activity') ?? [];
  const personal = k?.categories.filter((c) => c.personal && (c.planned || c.actual)) ?? [];
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
              <div className="sub">income {t.borrowed_actual > 0 ? '+ borrowed ' : ''}− spending − savings</div>
            </div>
            {t.borrowed_actual > 0 && (
              <div className="tile">
                <div className="label">Borrowed</div>
                <div className="value" style={{ color: 'var(--warning-text)' }}>
                  {money(t.borrowed_actual, { whole: true })}
                </div>
                <div className="sub">not income — to be repaid</div>
              </div>
            )}
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

          {personal.length > 0 && (
            <div className="card">
              <h2>Spending money</h2>
              <div className="tiles" style={{ marginBottom: 0 }}>
                {personal.map((c) => (
                  <Link key={c.category_id} to={`/transactions?category=${c.category_id}`} className="tile" style={{ color: 'inherit', textDecoration: 'none' }}>
                    <div className="label">
                      {c.icon} {c.name}
                    </div>
                    <div className="value" style={{ color: c.remaining < 0 ? 'var(--critical-text)' : undefined }}>
                      {money(c.remaining, { whole: true })}
                    </div>
                    <div className="sub">
                      {c.remaining < 0 ? 'over — ' : 'left — '}
                      {money(c.actual, { whole: true })} of {money(c.planned, { whole: true })} spent
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          )}

          {goalsOverview && goalsOverview.goals.length > 0 && (
            <div className="card">
              <div className="row" style={{ marginBottom: '0.5rem' }}>
                <h2 style={{ margin: 0 }}>Savings goals</h2>
                <span className="spacer" />
                <span className="small muted">{money(goalsOverview.total, { whole: true })} saved</span>{' '}
                <Link to="/savings" className="small">
                  Open
                </Link>
              </div>
              <div className="goals">
                {goalsOverview.goals.map((g) => (
                  <div className="goal" key={g.id}>
                    <div className="row small">
                      <span>
                        {g.icon} {g.name}
                      </span>
                      <span className="spacer" />
                      <span>
                        {money(g.balance, { whole: true })}
                        {g.target !== null && <span className="muted"> / {money(g.target, { whole: true })}</span>}
                      </span>
                    </div>
                    {g.target !== null && (
                      <div className="goal-bar" title={`${(g.pct ?? 0).toFixed(0)}% of target`}>
                        <div className="goal-fill" style={{ width: `${Math.max(0, g.pct ?? 0)}%` }} />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {k.borrowed_unplanned.length > 0 && (
            <div className="notice">
              🤝 {k.borrowed_unplanned.length === 1 ? 'Borrowed money has' : `${k.borrowed_unplanned.length} amounts borrowed have`} no repayment plan yet:{' '}
              {k.borrowed_unplanned.map((b, i) => (
                <span key={b.transaction_id}>
                  {i > 0 && ', '}
                  {money(b.amount)} on {shortDate(b.date)}
                </span>
              ))}
              . Open it in <Link to={`/transactions?category=${k.categories.find((c) => c.kind === 'loan')?.category_id ?? ''}`}>Transactions</Link> and choose <em>Set up repayment</em> so the repayment is in the budget.
            </div>
          )}

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
                {k.groups.length > 1 || (k.groups[0] && k.groups[0].group_id)
                  ? k.groups.map((g) => (
                      <GroupBlock
                        key={g.group_id ?? 'other'}
                        g={g}
                        members={k.categories.filter((c) => c.kind === 'expense' && g.category_ids.includes(c.category_id))}
                        all={k.categories}
                        fraction={k.elapsed_fraction}
                      />
                    ))
                  : expenses
                      .slice()
                      .sort((a, b) => b.actual - a.actual)
                      .map((c) => <WithChildren key={c.category_id ?? 'uncat'} c={c} all={k.categories} fraction={k.elapsed_fraction} />)}
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
