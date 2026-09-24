import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { money } from '../format';
import { SavingsAllocation, SavingsGoal, Transaction } from '../types';

/** Shares a transfer into savings (or a withdrawal from it) over pots. */
export default function SavingsAllocate({ tx, goals, onSaved }: { tx: Transaction; goals: SavingsGoal[]; onSaved: () => void }) {
  const [current, setCurrent] = useState<SavingsAllocation[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .allocations(tx.id)
      .then((a) => {
        setCurrent(a);
        setValues(Object.fromEntries(a.map((x) => [x.goal_id, String(Math.abs(x.amount))])));
      })
      .catch(() => setCurrent([]));
  }, [tx.id]);

  // Pots only: a goal with its own imported account already sees the money.
  const pots = goals.filter((g) => g.balance_source === 'movements' || current?.some((c) => c.goal_id === g.id));
  if (!current || !pots.length) return null;

  const total = Object.values(values).reduce((a, v) => a + (parseFloat(v) || 0), 0);
  const left = Math.abs(tx.amount) - total;
  // Money leaving another account tops a pot up; leaving the pot's own account takes from it.
  const verb = (g: SavingsGoal) => ((g.account_id === tx.account_id ? tx.amount > 0 : tx.amount < 0) ? 'top up' : 'take from');

  async function save() {
    try {
      const r = await api.setAllocations(
        tx.id,
        pots.map((g) => ({ goal_id: g.id, amount: parseFloat(values[g.id]) || 0 })).filter((a) => a.amount > 0)
      );
      setCurrent(r);
      setOpen(false);
      setError(null);
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!open) {
    return (
      <div className="row small">
        <span className="muted">Savings pots:</span>
        {current.length ? current.map((a) => `${a.goal_name} ${money(a.amount, { signed: true })}`).join(', ') : 'none'}
        <button className="link small" onClick={() => setOpen(true)}>
          {current.length ? 'Change' : 'Share over pots'}
        </button>
      </div>
    );
  }
  return (
    <div>
      <div className="small muted" style={{ marginBottom: 4 }}>
        Share {money(Math.abs(tx.amount))} over savings pots
      </div>
      {error && <div className="error">{error}</div>}
      <div style={{ display: 'grid', gap: 4 }}>
        {pots.map((g) => (
          <label key={g.id} className="row small" style={{ gap: 6 }}>
            <input
              type="number"
              inputMode="decimal"
              value={values[g.id] ?? ''}
              onChange={(e) => setValues({ ...values, [g.id]: e.target.value })}
              style={{ width: '8rem', textAlign: 'right' }}
            />
            {verb(g)} {g.icon} {g.name}
            {g.account_name ? <span className="muted">({g.account_name})</span> : null}
          </label>
        ))}
      </div>
      <div className="row small" style={{ marginTop: 6 }}>
        <span style={{ color: left < -0.009 ? 'var(--critical-text)' : 'var(--muted)' }}>
          {left < -0.009 ? `${money(-left)} more than the transaction` : `${money(left)} not in a pot`}
        </span>
        <span className="spacer" />
        <button className="primary small" onClick={save} disabled={left < -0.009}>
          Save
        </button>
        <button className="small" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
