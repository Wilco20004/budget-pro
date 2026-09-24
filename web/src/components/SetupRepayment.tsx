import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { money, shortDate } from '../format';
import { Category, PaymentPlan, PlanFrequency, Transaction } from '../types';

/** Borrowed money in: shows its repayment plan, or sets one up so the
 *  repayment lands in the budget of the period it's due. */
export default function SetupRepayment({
  tx,
  categories,
  plans,
  onSaved,
}: {
  tx: Transaction;
  categories: Category[];
  plans: PaymentPlan[];
  onSaved: () => void;
}) {
  const plan = plans.find((p) => p.loan_transaction_id === tx.id);
  const spending = categories.filter((c) => c.kind === 'expense' && !c.archived);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({
    repay: String(tx.amount),
    instalments: '1',
    frequency: 'monthly' as PlanFrequency,
    first_due: '',
    category_id: spending.find((c) => /debt/i.test(c.name))?.id ?? spending[0]?.id ?? '',
    match_pattern: '',
  });
  const [error, setError] = useState<string | null>(null);

  if (plan) {
    return (
      <div className="small">
        🤝 Repaid by <strong>{plan.name}</strong>: {plan.instalments} × {money(plan.instalment)}
        {plan.borrowed && plan.borrowed.cost > 0 ? ` (borrowing costs ${money(plan.borrowed.cost)})` : ''} ·{' '}
        {plan.paid_count}/{plan.instalments} paid{plan.next_due ? ` · next ${shortDate(plan.next_due)}` : ''} ·{' '}
        <Link to="/budget">Plan page</Link>
      </div>
    );
  }

  if (!open) {
    return (
      <div className="row small">
        <span style={{ color: 'var(--warning-text)' }}>🤝 Borrowed money — not income.</span>
        <button className="small primary" onClick={() => setOpen(true)}>
          Set up repayment
        </button>
      </div>
    );
  }

  const n = parseInt(f.instalments) || 1;
  const total = parseFloat(f.repay) || 0;
  async function save() {
    if (!f.first_due) return setError('When is the (first) repayment due?');
    try {
      await api.createPaymentPlan({
        name: `Repay ${tx.description.replace(/\s+\d[\d\s]{6,}.*$/, '').slice(0, 40)}`,
        category_id: f.category_id,
        instalment: Math.round((total / n) * 100) / 100,
        instalments: n,
        frequency: f.frequency,
        first_due: f.first_due,
        match_pattern: f.match_pattern.trim() || null,
        loan_transaction_id: tx.id,
      });
      setOpen(false);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div>
      <div className="small muted" style={{ marginBottom: 4 }}>
        Repayment of {money(tx.amount)} borrowed on {shortDate(tx.date)}
      </div>
      {error && <div className="error">{error}</div>}
      <div className="form-grid">
        <label className="field">
          Total to repay (incl. fees/interest)
          <input type="number" inputMode="decimal" value={f.repay} onChange={(e) => setF({ ...f, repay: e.target.value })} />
        </label>
        <label className="field">
          In instalments
          <input type="number" min={1} value={f.instalments} onChange={(e) => setF({ ...f, instalments: e.target.value })} />
        </label>
        {n > 1 && (
          <label className="field">
            How often
            <select value={f.frequency} onChange={(e) => setF({ ...f, frequency: e.target.value as PlanFrequency })}>
              <option value="monthly">Monthly</option>
              <option value="fortnightly">Every 2 weeks</option>
              <option value="weekly">Weekly</option>
            </select>
          </label>
        )}
        <label className="field">
          {n > 1 ? 'First repayment' : 'Repayment due'}
          <input type="date" value={f.first_due} onChange={(e) => setF({ ...f, first_due: e.target.value })} />
        </label>
        <label className="field">
          Budget category
          <select value={f.category_id} onChange={(e) => setF({ ...f, category_id: e.target.value })}>
            {spending.map((c) => (
              <option key={c.id} value={c.id}>
                {c.icon} {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Repayment's statement text (optional)
          <input value={f.match_pattern} onChange={(e) => setF({ ...f, match_pattern: e.target.value })} placeholder="e.g. LOAN REPAYMENT" />
        </label>
      </div>
      <div className="row small" style={{ marginTop: 6 }}>
        <span className="muted">
          {n} × {money(total / n)}
          {total > tx.amount ? ` — borrowing costs ${money(total - tx.amount)}` : ''}
        </span>
        <span className="spacer" />
        <button className="primary small" onClick={save}>
          Save repayment plan
        </button>
        <button className="small" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
