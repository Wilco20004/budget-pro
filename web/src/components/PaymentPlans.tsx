import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { money, shortDate, todayIso } from '../format';
import { BudgetLine, PaymentPlan, PlanFrequency } from '../types';
import ConfirmButton from './ConfirmButton';

const FREQ_LABEL: Record<PlanFrequency, string> = { monthly: 'monthly', fortnightly: 'every 2 weeks', weekly: 'weekly' };
const STATUS_LABEL: Record<PaymentPlan['status'], string> = {
  upcoming: 'starts later',
  active: 'running',
  paid_off: '✓ paid off',
  ended: 'ended',
};

// Buy-now-pay-later services as they usually run; the user can change any field.
const PRESETS: { label: string; name: string; pattern: string; instalments: number; frequency: PlanFrequency }[] = [
  { label: 'PayJustNow', name: 'PayJustNow', pattern: 'PAYJUSTNOW', instalments: 3, frequency: 'monthly' },
  { label: 'PayFlex', name: 'PayFlex', pattern: 'PAYFLEX', instalments: 4, frequency: 'fortnightly' },
  { label: 'Medical account', name: 'Medical account', pattern: '', instalments: 6, frequency: 'monthly' },
];

interface Draft {
  id?: string;
  name: string;
  category_id: string;
  total: string;
  instalment: string;
  instalments: string;
  frequency: PlanFrequency;
  first_due: string;
  match_pattern: string;
  notes: string;
}

const blank = (categoryId: string): Draft => ({
  name: '',
  category_id: categoryId,
  total: '',
  instalment: '',
  instalments: '3',
  frequency: 'monthly',
  first_due: todayIso(),
  match_pattern: '',
  notes: '',
});

function PlanForm({
  draft,
  setDraft,
  categories,
  onSave,
  onCancel,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  categories: BudgetLine[];
  onSave: () => void;
  onCancel: () => void;
}) {
  const n = parseInt(draft.instalments) || 0;
  const set = (p: Partial<Draft>) => {
    const d = { ...draft, ...p };
    // Typing the purchase total (or changing the count) works out the instalment.
    if (('total' in p || 'instalments' in p) && parseFloat(d.total) && parseInt(d.instalments)) {
      d.instalment = (Math.round((parseFloat(d.total) / parseInt(d.instalments)) * 100) / 100).toFixed(2);
    }
    setDraft(d);
  };
  return (
    <div className="plan-form">
      {!draft.id && (
        <div className="row small" style={{ gap: 6, marginBottom: '0.5rem' }}>
          Start from:
          {PRESETS.map((p) => (
            <button
              key={p.label}
              className="small"
              onClick={() => set({ name: p.name, match_pattern: p.pattern, instalments: String(p.instalments), frequency: p.frequency })}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
      <div className="form-grid">
        <label className="field">
          Name
          <input value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="PayJustNow — kids' shoes" />
        </label>
        <label className="field">
          Budget category
          <select value={draft.category_id} onChange={(e) => set({ category_id: e.target.value })}>
            {categories.map((c) => (
              <option key={c.category_id} value={c.category_id}>
                {c.icon} {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Total to pay (optional)
          <input type="number" inputMode="decimal" value={draft.total} onChange={(e) => set({ total: e.target.value })} />
        </label>
        <label className="field">
          Number of instalments
          <input type="number" min={1} max={120} value={draft.instalments} onChange={(e) => set({ instalments: e.target.value })} />
        </label>
        <label className="field">
          Instalment amount
          <input type="number" inputMode="decimal" value={draft.instalment} onChange={(e) => set({ instalment: e.target.value })} />
        </label>
        <label className="field">
          How often
          <select value={draft.frequency} onChange={(e) => set({ frequency: e.target.value as PlanFrequency })}>
            <option value="monthly">Monthly</option>
            <option value="fortnightly">Every 2 weeks</option>
            <option value="weekly">Weekly</option>
          </select>
        </label>
        <label className="field">
          First payment
          <input type="date" value={draft.first_due} onChange={(e) => set({ first_due: e.target.value })} />
        </label>
        <label className="field">
          Statement text (optional)
          <input value={draft.match_pattern} onChange={(e) => set({ match_pattern: e.target.value })} placeholder="PAYJUSTNOW" />
        </label>
      </div>
      <p className="small muted">
        {n > 0 && parseFloat(draft.instalment) > 0
          ? `${n} × ${money(parseFloat(draft.instalment))} ${FREQ_LABEL[draft.frequency]} = ${money(n * parseFloat(draft.instalment))}. `
          : ''}
        Each instalment is added to the category’s budget in the period it’s due, and drops off once the plan is done. With statement
        text, bank lines containing it for about the instalment amount are linked to the plan automatically.
      </p>
      <div className="row">
        <button className="primary" onClick={onSave}>
          {draft.id ? 'Save plan' : 'Add plan'}
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/** Temporary instalment commitments on the Plan page. */
export default function PaymentPlans({
  periodStart,
  plans,
  categories,
  onChange,
}: {
  periodStart: string;
  plans: PaymentPlan[];
  categories: BudgetLine[];
  onChange: () => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [all, setAll] = useState<PaymentPlan[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const spending = categories.filter((c) => c.kind !== 'income');
  const defaultCat =
    spending.find((c) => /debt/i.test(c.name))?.category_id ?? spending.find((c) => c.kind === 'expense')?.category_id ?? '';

  useEffect(() => {
    if (showAll) api.paymentPlans(periodStart).then(setAll).catch((e) => setError(e.message));
  }, [showAll, periodStart, plans]);

  const shown = showAll && all ? all : plans;
  const refresh = () => {
    setDraft(null);
    setError(null);
    onChange();
  };

  async function save() {
    if (!draft) return;
    const body = {
      name: draft.name.trim(),
      category_id: draft.category_id,
      instalment: parseFloat(draft.instalment),
      instalments: parseInt(draft.instalments),
      frequency: draft.frequency,
      first_due: draft.first_due,
      match_pattern: draft.match_pattern.trim() || null,
      notes: draft.notes.trim() || null,
    };
    try {
      if (draft.id) {
        const existing = shown.find((p) => p.id === draft.id);
        await api.updatePaymentPlan(draft.id, { ...body, ended_on: existing?.ended_on ?? null });
      } else await api.createPaymentPlan(body);
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const edit = (p: PaymentPlan) =>
    setDraft({
      id: p.id,
      name: p.name,
      category_id: p.category_id,
      total: '',
      instalment: String(p.instalment),
      instalments: String(p.instalments),
      frequency: p.frequency,
      first_due: p.first_due,
      match_pattern: p.match_pattern ?? '',
      notes: p.notes ?? '',
    });

  const setEnded = (p: PaymentPlan, ended_on: string | null) =>
    api
      .updatePaymentPlan(p.id, { ...p, ended_on })
      .then(refresh)
      .catch((e) => setError(e.message));

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: '0.25rem' }}>
        <h2 style={{ margin: 0 }}>Payment plans</h2>
        <span className="spacer" />
        <label className="row small" style={{ gap: 4 }}>
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          Show finished
        </label>
      </div>
      <p className="small muted" style={{ marginTop: 0 }}>
        PayJustNow, PayFlex, a medical account paid off monthly: the instalments are added to their category’s budget only while
        the plan runs.
      </p>
      {error && <div className="error">{error}</div>}

      {shown.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Plan</th>
                <th>Progress</th>
                <th className="num">This period</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => (
                <tr key={p.id} style={{ opacity: p.status === 'paid_off' || p.status === 'ended' ? 0.6 : 1 }}>
                  <td>
                    <strong>{p.name}</strong>
                    <div className="small muted">
                      {p.category_icon} {p.category_name} · {p.instalments} × {money(p.instalment)} {FREQ_LABEL[p.frequency]}
                    </div>
                  </td>
                  <td className="small">
                    {p.paid_count} of {p.instalments} paid · {money(p.remaining)} left
                    <div className="muted">
                      {STATUS_LABEL[p.status]}
                      {p.next_due ? ` · next ${shortDate(p.next_due)}` : ''}
                      {p.last_due && p.status !== 'ended' ? ` · last ${shortDate(p.last_due)}` : ''}
                      {p.paid_count > 0 && (
                        <>
                          {' · '}
                          <Link to={`/transactions?plan=${p.id}&period=all`}>payments</Link>
                        </>
                      )}
                    </div>
                  </td>
                  <td className="num">{p.this_period ? money(p.this_period, { whole: true }) : '–'}</td>
                  <td>
                    <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                    <button className="small" onClick={() => edit(p)}>
                      Edit
                    </button>
                    {p.status === 'ended' ? (
                      <button className="small" onClick={() => setEnded(p, null)}>
                        Resume
                      </button>
                    ) : p.status !== 'paid_off' ? (
                      <ConfirmButton
                        className="small"
                        question="Settled early or cancelled? Instalments after today leave the budget."
                        yes="End plan"
                        onConfirm={() => setEnded(p, todayIso())}
                      >
                        End
                      </ConfirmButton>
                    ) : null}
                    <ConfirmButton
                      className="small danger"
                      question="Delete this plan? Its payments keep their category."
                      yes="Delete"
                      onConfirm={() =>
                        api
                          .deletePaymentPlan(p.id)
                          .then(refresh)
                          .catch((e) => setError(e.message))
                      }
                    >
                      Delete
                    </ConfirmButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {draft ? (
        <PlanForm draft={draft} setDraft={setDraft} categories={spending} onSave={save} onCancel={() => setDraft(null)} />
      ) : (
        <button style={{ marginTop: '0.5rem' }} onClick={() => setDraft(blank(defaultCat))}>
          + Add payment plan
        </button>
      )}
    </div>
  );
}
