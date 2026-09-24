import { Fragment, useEffect, useState } from 'react';
import { api } from '../api/client';
import PaymentPlans from '../components/PaymentPlans';
import { PeriodPicker, usePeriod } from '../components/PeriodContext';
import { money } from '../format';
import { Link } from 'react-router-dom';
import { BudgetLine, DebtOverview, PaymentPlan } from '../types';

const KIND_TITLE: Record<string, string> = { income: 'Expected income', expense: 'Spending', savings: 'Savings' };

export default function Budget() {
  const { selected } = usePeriod();
  const [lines, setLines] = useState<BudgetLine[]>([]);
  const [plans, setPlans] = useState<PaymentPlan[]>([]);
  const [debts, setDebts] = useState<DebtOverview | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [setDefault, setSetDefault] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // keepValues: a payment plan changed — refresh the plan add-ons without losing unsaved typing.
  const load = (keepValues = false) => {
    if (!selected) return;
    api
      .budget(selected.start)
      .then((b) => {
        setLines(b.lines);
        setPlans(b.payment_plans);
        if (keepValues) return;
        setValues(Object.fromEntries(b.lines.map((l) => [l.category_id, l.planned ? String(l.planned) : ''])));
        setDirty(false);
      })
      .catch((e) => setError(e.message));
  };
  useEffect(() => load(), [selected?.start]);
  useEffect(() => {
    if (selected) api.debts(selected.start).then(setDebts).catch(() => setDebts(null));
  }, [selected?.start]);

  // What a line plans in total: the amount typed in plus payment plan instalments due this period.
  const lineTotal = (l: BudgetLine) => (parseFloat(values[l.category_id]) || 0) + l.plans + l.goals;
  const hasKids = (l: BudgetLine) => lines.some((x) => x.parent_id === l.category_id);
  const kidsTotal = (l: BudgetLine) => lines.filter((x) => x.parent_id === l.category_id).reduce((a, x) => a + lineTotal(x), 0);
  const total = (kind: string) => lines.filter((l) => l.kind === kind).reduce((a, l) => a + lineTotal(l), 0);
  const income = total('income');
  // Repayments to tracked cards/loans: their costs are in Bank fees etc.; what
  // pays the balance down is planned here, like savings.
  const paydown = debts?.totals.planned_paydown ?? 0;
  const out = total('expense') + total('savings') + paydown;

  async function save() {
    if (!selected) return;
    try {
      await api.saveBudget(
        selected.start,
        lines.map((l) => ({ category_id: l.category_id, amount: parseFloat(values[l.category_id]) || 0 })),
        setDefault
      );
      setMsg(setDefault ? 'Saved for this period and as the default for future periods.' : 'Saved for this period.');
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>Plan</h1>
        <PeriodPicker />
      </div>
      {error && <div className="error">{error}</div>}
      {msg && (
        <div className="notice" onClick={() => setMsg(null)}>
          {msg}
        </div>
      )}

      <div className="tiles">
        <div className="tile">
          <div className="label">Expected income</div>
          <div className="value">{money(income, { whole: true })}</div>
        </div>
        <div className="tile">
          <div className="label">Planned out</div>
          <div className="value">{money(out, { whole: true })}</div>
          <div className="sub">spending + savings{paydown ? ' + debt paydown' : ''}</div>
        </div>
        <div className="tile">
          <div className="label">Unallocated</div>
          <div className="value" style={{ color: income - out < 0 ? 'var(--critical-text)' : 'var(--good-text)' }}>
            {money(income - out, { whole: true, signed: true })}
          </div>
          <div className="sub">{income - out < 0 ? 'over-committed' : 'give every rand a job'}</div>
        </div>
      </div>

      {(['income', 'expense', 'savings'] as const).map((kind) => {
        const ls = lines.filter((l) => l.kind === kind);
        if (!ls.length) return null;
        return (
          <div className="card" key={kind}>
            <h2>{KIND_TITLE[kind]}</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Category</th>
                    <th className="num">Last period</th>
                    <th className="num">This period</th>
                    <th className="num">Planned</th>
                  </tr>
                </thead>
                <tbody>
                  {ls.map((l, i) => (
                    <Fragment key={l.category_id}>
                    {kind === 'expense' && (i === 0 || ls[i - 1].group_id !== l.group_id) && (
                      <tr className="group-row">
                        <td>{l.group_name ?? 'Other'}</td>
                        <td className="num">
                          {money(
                            ls.filter((x) => x.group_id === l.group_id).reduce((a, x) => a + x.previous_actual, 0),
                            { whole: true }
                          )}
                        </td>
                        <td className="num">
                          {money(
                            ls.filter((x) => x.group_id === l.group_id).reduce((a, x) => a + x.actual, 0),
                            { whole: true }
                          )}
                        </td>
                        <td className="num">
                          {money(
                            ls
                              .filter((x) => x.group_id === l.group_id)
                              .reduce((a, x) => a + lineTotal(x), 0),
                            { whole: true }
                          )}
                        </td>
                      </tr>
                    )}
                    <tr className={l.parent_id ? 'sub-row' : undefined}>
                      <td>
                        {l.parent_id && <span className="muted">↳ </span>}
                        <span className="icon">{l.icon}</span> {l.name}
                        {hasKids(l) && (
                          <div className="small muted">
                            not split further · with subcategories {money(lineTotal(l) + kidsTotal(l), { whole: true })}
                          </div>
                        )}
                        {l.requires_slip ? <span className="small muted"> · slip required</span> : null}
                        {l.personal ? <span className="small muted"> · spending money</span> : null}
                        {l.goals > 0 && (
                          <div className="small muted">+ {money(l.goals, { whole: true })} savings goal top-ups</div>
                        )}
                        {l.plans > 0 && (
                          <div className="small muted">+ {money(l.plans, { whole: true })} payment plans this period</div>
                        )}
                      </td>
                      <td className="num">
                        <button
                          className="link small"
                          title="Use this amount"
                          onClick={() => {
                            setValues({ ...values, [l.category_id]: String(Math.round(l.previous_actual)) });
                            setDirty(true);
                          }}
                        >
                          {money(l.previous_actual, { whole: true })}
                        </button>
                      </td>
                      <td
                        className="num small"
                        style={{ color: kind !== 'income' && l.actual > lineTotal(l) + 0.5 && lineTotal(l) > 0 ? 'var(--critical-text)' : undefined }}
                      >
                        {money(l.actual, { whole: true })}
                      </td>
                      <td className="num">
                        <input
                          type="number"
                          step="1"
                          inputMode="decimal"
                          value={values[l.category_id] ?? ''}
                          onChange={(e) => {
                            setValues({ ...values, [l.category_id]: e.target.value });
                            setDirty(true);
                          }}
                          style={{ width: '8rem', textAlign: 'right' }}
                        />
                      </td>
                    </tr>
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}

      {selected && (
        <PaymentPlans periodStart={selected.start} plans={plans} categories={lines} onChange={() => load(true)} />
      )}

      {debts && debts.debts.length > 0 && (
        <div className="card">
          <div className="row" style={{ marginBottom: '0.25rem' }}>
            <h2 style={{ margin: 0 }}>Debt paydown</h2>
            <span className="spacer" />
            <Link to="/debt" className="small">
              Plan repayments
            </Link>
          </div>
          <p className="small muted" style={{ marginTop: 0 }}>
            Repayments to your tracked cards and loans. Their interest and fees are spending (in Bank fees); the rest pays the
            balance down and is planned here, like savings.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Account</th>
                  <th className="num">Owed</th>
                  <th className="num">Repayment</th>
                  <th className="num">Pays down</th>
                </tr>
              </thead>
              <tbody>
                {debts.debts.map((d) => (
                  <tr key={d.account_id}>
                    <td>{d.name}</td>
                    <td className="num">{d.owed === null ? '—' : money(d.owed, { whole: true })}</td>
                    <td className="num">{d.planned_payment ? money(d.planned_payment, { whole: true }) : <Link to="/debt" className="small">set</Link>}</td>
                    <td className="num">{money(d.planned_paydown, { whole: true })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="row">
        <label className="row small" style={{ gap: 4 }}>
          <input type="checkbox" checked={setDefault} onChange={(e) => setSetDefault(e.target.checked)} />
          Also use as the default for future periods
        </label>
        <span className="spacer" />
        <button
          onClick={() =>
            selected &&
            api
              .copyPreviousBudget(selected.start)
              .then(() => {
                setMsg('Copied last period’s plan.');
                load();
              })
              .catch((e) => setError(e.message))
          }
        >
          Copy last period’s plan
        </button>
        <button className="primary" onClick={save} disabled={!dirty}>
          Save plan
        </button>
      </div>
    </>
  );
}
