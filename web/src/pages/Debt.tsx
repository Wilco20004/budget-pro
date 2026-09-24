import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { PeriodPicker, usePeriod } from '../components/PeriodContext';
import { money, shortDate } from '../format';
import { DebtAccount, DebtOverview } from '../types';

const STATUS: Record<DebtAccount['status'], { text: string; color: string } | null> = {
  no_plan: null,
  paid: { text: '✓ Paid as planned', color: 'var(--good-text)' },
  due: { text: 'Not paid yet', color: 'var(--ink-2)' },
  short: { text: '⚠ Paid less than planned', color: 'var(--critical-text)' },
};

function monthYear(iso: string) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

/** A plan field saved when the input loses focus. */
function PlanInput({ label, value, suffix, onSave }: { label: string; value: number | null; suffix?: string; onSave: (v: number | null) => void }) {
  return (
    <label className="field">
      {label}
      <span className="row" style={{ gap: 4 }}>
        <input
          type="number"
          inputMode="decimal"
          defaultValue={value ?? ''}
          style={{ width: '8rem', textAlign: 'right' }}
          onBlur={(e) => {
            const v = e.target.value === '' ? null : parseFloat(e.target.value);
            if (v !== value) onSave(v);
          }}
        />
        {suffix && <span className="small muted">{suffix}</span>}
      </span>
    </label>
  );
}

function DebtCard({ d, onSave }: { d: DebtAccount; onSave: (p: Partial<Record<'planned_payment' | 'interest_rate' | 'credit_limit', number | null>>) => void }) {
  const status = STATUS[d.status];
  const p = d.this_period;
  const known = d.history.filter((h) => h.owed !== null);
  const peak = Math.max(...known.map((h) => h.owed ?? 0), 1);
  return (
    <div className="card">
      <div className="row" style={{ alignItems: 'baseline', marginBottom: '0.5rem' }}>
        <h2 style={{ margin: 0 }}>{d.name}</h2>
        <span className="small muted">{d.type === 'loan' ? 'loan' : 'credit card'}</span>
        <span className="spacer" />
        <span className="small muted">owed</span>
        <strong style={{ fontSize: '1.25rem' }}>{d.owed === null ? '—' : money(d.owed, { whole: true })}</strong>
      </div>

      {d.credit_limit && d.utilisation !== null && (
        <div style={{ marginBottom: '0.5rem' }}>
          <div className="goal-bar" title={`${d.utilisation.toFixed(0)}% of the R${d.credit_limit} limit used`}>
            <div className="goal-fill" style={{ width: `${Math.min(100, Math.max(0, d.utilisation))}%`, background: d.utilisation > 90 ? 'var(--critical)' : undefined }} />
          </div>
          <div className="small muted">
            {d.utilisation.toFixed(0)}% of the {money(d.credit_limit, { whole: true })} limit · {money(d.available ?? 0, { whole: true })} available
          </div>
        </div>
      )}

      <div className="form-grid">
        <PlanInput label="Planned repayment per period" value={d.planned_payment} onSave={(v) => onSave({ planned_payment: v })} />
        {/* Same number as this debt's line under Debt repayments on the Plan page. */}
        <PlanInput label="Interest rate" value={d.interest_rate} suffix="% a year" onSave={(v) => onSave({ interest_rate: v })} />
        {d.type === 'credit' && <PlanInput label="Credit limit" value={d.credit_limit} onSave={(v) => onSave({ credit_limit: v })} />}
      </div>

      <table className="small" style={{ marginTop: '0.5rem' }}>
        <tbody>
          <tr>
            <td className="muted">Paid this period</td>
            <td className="num">
              {money(p.paid)}
              {d.planned_payment ? <span className="muted"> of {money(d.planned_payment)}</span> : null}
            </td>
            <td>{status && <span style={{ color: status.color }}>{status.text}</span>}</td>
          </tr>
          <tr>
            <td className="muted">Interest, fees &amp; cover</td>
            <td className="num">{money(p.costs)}</td>
            <td className="muted">cost of the debt</td>
          </tr>
          {p.purchases > 0 && (
            <tr>
              <td className="muted">Purchases &amp; cash out</td>
              <td className="num">{money(p.purchases)}</td>
              <td className="muted">in their own categories, or transfers</td>
            </tr>
          )}
          <tr>
            <td className="muted">Balance {p.paid_down !== null && p.paid_down < 0 ? 'grew' : 'paid down'}</td>
            <td className="num" style={{ color: p.paid_down !== null && p.paid_down < 0 ? 'var(--critical-text)' : 'var(--good-text)' }}>
              {p.paid_down === null ? '—' : money(Math.abs(p.paid_down))}
            </td>
            <td className="muted">{d.planned_paydown ? `planned ${money(d.planned_paydown)}` : ''}</td>
          </tr>
        </tbody>
      </table>

      {d.payoff && (
        <p className="small" style={{ marginBottom: 0 }}>
          {d.payoff.never ? (
            <span style={{ color: 'var(--critical-text)' }}>
              ⚠ At {money(d.planned_payment ?? 0)} a period the repayment doesn’t cover the interest — the balance won’t go down.
            </span>
          ) : d.payoff.months === 0 ? (
            '✓ Paid off.'
          ) : (
            <>
              At {money(d.planned_payment ?? 0)} a period{d.interest_rate ? ` and ${d.interest_rate}%` : ''}: paid off around{' '}
              <strong>{d.payoff.date ? monthYear(d.payoff.date) : '—'}</strong> ({d.payoff.months} months)
              {d.payoff.interest ? <> · about {money(d.payoff.interest, { whole: true })} interest still to pay</> : null}
              {!d.interest_rate && <span className="muted"> (add the interest rate for a truer estimate)</span>}
              {d.type === 'credit' && <span className="muted"> — if nothing new goes on the card</span>}
            </>
          )}
        </p>
      )}

      {known.length > 1 && (
        <div className="debt-history" aria-label="Owed at the end of each period">
          {known.map((h) => (
            <div key={h.period} className="debt-bar" title={`${h.label}: ${money(h.owed)}`}>
              <div className="debt-fill" style={{ height: `${Math.max(4, ((h.owed ?? 0) / peak) * 100)}%` }} />
              <span className="small muted">{shortDate(h.period).replace(/ \d{4}$/, '')}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Debt() {
  const { selected } = usePeriod();
  const [o, setO] = useState<DebtOverview | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    if (!selected) return;
    api.debts(selected.start).then(setO).catch((e) => setError(e.message));
  };
  useEffect(load, [selected?.start]);

  const t = o?.totals;
  return (
    <>
      <div className="page-head">
        <h1>Debt</h1>
        <PeriodPicker />
      </div>
      {error && (
        <div className="error" onClick={() => setError(null)}>
          {error}
        </div>
      )}
      {msg && (
        <div className="notice" onClick={() => setMsg(null)}>
          {msg}
        </div>
      )}
      {t && (
        <div className="tiles">
          <div className="tile">
            <div className="label">Owed</div>
            <div className="value">{money(t.owed, { whole: true })}</div>
            <div className="sub">
              {o.debts.length} account{o.debts.length === 1 ? '' : 's'}
            </div>
          </div>
          <div className="tile">
            <div className="label">Paid this period</div>
            <div className="value">{money(t.paid, { whole: true })}</div>
            <div className="sub">of {money(t.planned_payment, { whole: true })} planned</div>
          </div>
          <div className="tile">
            <div className="label">{t.paid_down < 0 ? 'Debt grew by' : 'Paid down'}</div>
            <div className="value" style={{ color: t.paid_down < 0 ? 'var(--critical-text)' : 'var(--good-text)' }}>
              {money(Math.abs(t.paid_down), { whole: true })}
            </div>
            <div className="sub">planned {money(t.planned_paydown, { whole: true })}</div>
          </div>
          <div className="tile">
            <div className="label">Cost of debt</div>
            <div className="value">{money(t.costs, { whole: true })}</div>
            <div className="sub">interest, fees &amp; cover this period</div>
          </div>
        </div>
      )}

      <p className="small muted">
        Credit cards and loans you import statements for. Each has its own line under Debt repayments on the{' '}
        <Link to="/budget">Plan</Link> page: planned = the repayment below, actual = the debt's interest, fees and cover plus how much the
        balance came down. The repayment itself is a transfer from the paying account.
        Accounts are added under <Link to="/setup">Setup → Accounts</Link> (type Credit card or Loan).
      </p>

      {o?.debts.length === 0 && <div className="card empty">No credit card or loan accounts yet.</div>}
      {o?.debts.map((d) => (
        <DebtCard
          key={d.account_id}
          d={d}
          onSave={(p) =>
            selected &&
            api
              .updateDebt(d.account_id, p)
              .then(load)
              .catch((e) => setError(e.message))
          }
        />
      ))}

      <div className="row">
        <span className="spacer" />
        <button
          className="small"
          title="Match repayments with the money leaving the paying account, and re-file loan lines imported before this page existed"
          onClick={() =>
            api
              .recheckDebts()
              .then((r) => {
                setMsg(`Re-filed ${r.refiled} loan line(s); matched ${r.paired} repayment(s) as transfers.`);
                load();
              })
              .catch((e) => setError(e.message))
          }
        >
          Re-check repayments
        </button>
      </div>
    </>
  );
}
