import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { PeriodPicker, usePeriod } from '../components/PeriodContext';
import { money } from '../format';
import { BudgetLine } from '../types';

const KIND_TITLE: Record<string, string> = { income: 'Expected income', expense: 'Spending', savings: 'Savings' };

export default function Budget() {
  const { selected } = usePeriod();
  const [lines, setLines] = useState<BudgetLine[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [setDefault, setSetDefault] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    if (!selected) return;
    api
      .budget(selected.start)
      .then((b) => {
        setLines(b.lines);
        setValues(Object.fromEntries(b.lines.map((l) => [l.category_id, l.planned ? String(l.planned) : ''])));
        setDirty(false);
      })
      .catch((e) => setError(e.message));
  };
  useEffect(load, [selected?.start]);

  const total = (kind: string) => lines.filter((l) => l.kind === kind).reduce((a, l) => a + (parseFloat(values[l.category_id]) || 0), 0);
  const income = total('income');
  const out = total('expense') + total('savings');

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
          <div className="sub">spending + savings</div>
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
                    <th className="num">Last period actual</th>
                    <th className="num">Planned</th>
                  </tr>
                </thead>
                <tbody>
                  {ls.map((l) => (
                    <tr key={l.category_id}>
                      <td>
                        <span className="icon">{l.icon}</span> {l.name}
                        {l.requires_slip ? <span className="small muted"> · slip required</span> : null}
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
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}

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
