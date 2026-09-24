import { Fragment, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import CategorySelect from '../components/CategorySelect';
import { PeriodPicker, usePeriod } from '../components/PeriodContext';
import ReceiptUpload from '../components/ReceiptUpload';
import SplitEditor from '../components/SplitEditor';
import { money, NO_SLIP_LABEL, shortDate, STATUS_ICON, STATUS_LABEL, todayIso } from '../format';
import { Account, Category, NoSlipReason, PaymentPlan, SavingsGoal, Transaction } from '../types';
import SavingsAllocate from '../components/SavingsAllocate';
import ConfirmButton from '../components/ConfirmButton';

const STATUSES = ['all', 'uncategorized', 'needs_slip', 'reconciled', 'ignored'] as const;
const REMEMBER_KEY = 'budgetpro.remember';

function StatusChip({ status }: { status: string }) {
  return (
    <span className={`chip status-${status}`}>
      {STATUS_ICON[status]} {STATUS_LABEL[status]}
    </span>
  );
}

/** Reconcile a slip-required transaction without a slip. */
function SkipSlip({ tx, onSkip }: { tx: Transaction; onSkip: (reason: NoSlipReason) => void }) {
  const only = tx.splits.length === 1 ? tx.splits[0].category_name : null;
  return (
    <span className="row small" style={{ gap: 6 }}>
      <span className="muted">or skip:</span>
      <button className="small" onClick={() => onSkip('lost')} title="The slip is gone — reconcile without one">
        Slip lost
      </button>
      <button
        className="small"
        onClick={() => onSkip('single_category')}
        title="Everything bought was this category, so there's nothing to split"
      >
        {only ? `All ${only}` : 'No split needed'}
      </button>
    </span>
  );
}

function Detail({
  tx,
  categories,
  plans,
  goals,
  onChanged,
}: {
  tx: Transaction;
  categories: Category[];
  plans: PaymentPlan[];
  goals: SavingsGoal[];
  onChanged: () => void;
}) {
  // Savings pots are offered for transfers and savings-category transactions.
  const savingsLike = tx.splits.some((s) => ['savings', 'transfer'].includes(categories.find((c) => c.id === s.category_id)?.kind ?? ''));
  const linkable = plans.filter((p) => p.id === tx.payment_plan_id || p.status === 'active' || p.status === 'upcoming');
  const [notes, setNotes] = useState(tx.notes ?? '');
  const [error, setError] = useState<string | null>(null);
  const run = (p: Promise<unknown>) =>
    p.then(onChanged).catch((e) => setError((e as Error).message));

  return (
    <div style={{ display: 'grid', gap: '0.9rem', padding: '0.5rem 0.25rem' }}>
      {error && <div className="error">{error}</div>}
      <div>
        <div className="small muted" style={{ marginBottom: 4 }}>
          Split over categories
        </div>
        <SplitEditor tx={tx} categories={categories} onSave={(splits) => api.setSplits(tx.id, splits).then(onChanged)} />
      </div>
      <div className="row">
        <span className="small muted">Slip:</span>
        {tx.receipt_id ? (
          <Link to={`/receipts/${tx.receipt_id}`}>View attached slip →</Link>
        ) : (
          <>
            <ReceiptUpload compact transactionId={tx.id} onUploaded={() => setTimeout(onChanged, 400)} />
            {tx.no_slip_reason ? (
              <span className="small">
                Reconciled without a slip ({NO_SLIP_LABEL[tx.no_slip_reason]}).{' '}
                <button className="link small" onClick={() => run(api.patchTransaction(tx.id, { no_slip_reason: null }))}>
                  Undo
                </button>
              </span>
            ) : (
              tx.status === 'needs_slip' && <SkipSlip tx={tx} onSkip={(reason) => run(api.patchTransaction(tx.id, { no_slip_reason: reason }))} />
            )}
          </>
        )}
      </div>
      {(savingsLike || goals.some((g) => g.account_id === tx.account_id)) && <SavingsAllocate tx={tx} goals={goals} onSaved={onChanged} />}
      {tx.amount < 0 && (tx.payment_plan_id || linkable.length > 0) && (
        <div className="row">
          <span className="small muted">Payment plan instalment:</span>
          <select
            value={tx.payment_plan_id ?? ''}
            onChange={(e) => run(api.patchTransaction(tx.id, { payment_plan_id: e.target.value || null }))}
            aria-label="Payment plan"
          >
            <option value="">— not a plan payment</option>
            {linkable.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({money(p.instalment)})
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="row">
        <input
          placeholder="Notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => notes !== (tx.notes ?? '') && run(api.patchTransaction(tx.id, { notes }))}
          style={{ flex: 1, minWidth: 200 }}
        />
        <button onClick={() => run(api.patchTransaction(tx.id, { ignored: !tx.ignored }))}>
          {tx.ignored ? 'Stop ignoring' : 'Ignore (don’t count)'}
        </button>
        <ConfirmButton
          className="danger"
          question="Delete it? Re-importing the statement would bring it back."
          yes="Delete"
          onConfirm={() => run(api.deleteTransaction(tx.id))}
        >
          Delete
        </ConfirmButton>
      </div>
      <div className="small muted">
        {tx.account_name}
        {tx.balance !== null ? ` · balance after ${money(tx.balance)}` : ''}
        {tx.merchant_name ? ` · merchant rule: ${tx.merchant_name}` : ''}
      </div>
    </div>
  );
}

function AddTransaction({ accounts, categories, onAdded }: { accounts: Account[]; categories: Category[]; onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ account_id: '', date: todayIso(), description: '', amount: '', out: true, category_id: null as string | null });
  const [error, setError] = useState<string | null>(null);
  if (!open) return <button onClick={() => setOpen(true)}>+ Add cash / manual</button>;
  return (
    <div className="card" style={{ width: '100%' }}>
      <h2>Add a transaction</h2>
      {error && <div className="error">{error}</div>}
      <div className="form-grid">
        <label className="field">
          Account
          <select value={f.account_id} onChange={(e) => setF({ ...f, account_id: e.target.value })}>
            <option value="">Choose…</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Date
          <input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
        </label>
        <label className="field">
          Description
          <input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </label>
        <label className="field">
          Amount
          <input type="number" step="0.01" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
        </label>
        <label className="field">
          Direction
          <select value={f.out ? 'out' : 'in'} onChange={(e) => setF({ ...f, out: e.target.value === 'out' })}>
            <option value="out">Money out</option>
            <option value="in">Money in</option>
          </select>
        </label>
        <label className="field">
          Category
          <CategorySelect categories={categories} value={f.category_id} onChange={(id) => setF({ ...f, category_id: id })} />
        </label>
      </div>
      <div className="row" style={{ marginTop: '0.75rem' }}>
        <button
          className="primary"
          onClick={() => {
            const amt = Math.abs(parseFloat(f.amount));
            api
              .createTransaction({
                account_id: f.account_id,
                date: f.date,
                description: f.description,
                amount: f.out ? -amt : amt,
                category_id: f.category_id ?? undefined,
              })
              .then(() => {
                setOpen(false);
                setF({ ...f, description: '', amount: '' });
                onAdded();
              })
              .catch((e) => setError(e.message));
          }}
        >
          Add
        </button>
        <button onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}

export default function Transactions() {
  const { selected } = usePeriod();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? 'all';
  const categoryFilter = params.get('category');
  const planFilter = params.get('plan');
  const [q, setQ] = useState('');
  const [accountId, setAccountId] = useState(params.get('account') ?? '');
  const [txs, setTxs] = useState<Transaction[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [plans, setPlans] = useState<PaymentPlan[]>([]);
  const [goals, setGoals] = useState<SavingsGoal[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [remember, setRemember] = useState(() => {
    try {
      return localStorage.getItem(REMEMBER_KEY) !== '0';
    } catch {
      return true;
    }
  });
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.categories().then(setCategories).catch(() => undefined);
    api.accounts().then(setAccounts).catch(() => undefined);
    api.paymentPlans().then(setPlans).catch(() => undefined);
    api.savings().then((o) => setGoals(o.goals)).catch(() => undefined);
  }, []);

  const load = () => {
    if (!selected) return;
    setLoading(true);
    api
      .transactions({
        // A plan's payments span periods, so its filter shows them all.
        period: planFilter ? 'all' : selected.start,
        payment_plan_id: planFilter ?? undefined,
        status,
        category_id: categoryFilter ?? undefined, account_id: accountId || undefined, q: q || undefined })
      .then((r) => {
        setTxs(r);
        setError(null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(load, [selected?.start, status, categoryFilter, planFilter, accountId]);
  useEffect(() => {
    const t = setTimeout(load, 300);
    return () => clearTimeout(t);
  }, [q]);

  const setStatus = (s: string) => {
    const next = new URLSearchParams(params);
    if (s === 'all') next.delete('status');
    else next.set('status', s);
    setParams(next);
  };

  async function quickCategorize(tx: Transaction, categoryId: string | null) {
    if (!categoryId) return;
    try {
      const r = await api.setCategory(tx.id, categoryId, remember);
      if (r.also_categorized > 0) setFlash(`Also categorised ${r.also_categorized} other matching transaction(s).`);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const catName = categoryFilter ? categories.find((c) => c.id === categoryFilter)?.name : null;
  const planName = planFilter ? plans.find((p) => p.id === planFilter)?.name ?? 'Payment plan' : null;
  const totalOut = txs.filter((t) => t.amount < 0 && !t.ignored).reduce((a, t) => a + t.amount, 0);
  const totalIn = txs.filter((t) => t.amount > 0 && !t.ignored).reduce((a, t) => a + t.amount, 0);

  return (
    <>
      <div className="page-head">
        <h1>Transactions</h1>
        <PeriodPicker />
      </div>
      {error && <div className="error">{error}</div>}
      {flash && (
        <div className="notice" onClick={() => setFlash(null)}>
          {flash}
        </div>
      )}

      <div className="tabs">
        {STATUSES.map((s) => (
          <button key={s} className={status === s ? 'active' : ''} onClick={() => setStatus(s)}>
            {s === 'all' ? 'All' : STATUS_LABEL[s]}
          </button>
        ))}
      </div>

      <div className="row" style={{ marginBottom: '0.75rem' }}>
        <input placeholder="Search description…" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 220 }} />
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          <option value="">All accounts</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        {planName && (
          <span className="chip">
            💳 {planName} (all periods)
            <button
              className="link"
              onClick={() => {
                const next = new URLSearchParams(params);
                next.delete('plan');
                setParams(next);
              }}
              aria-label="Clear payment plan filter"
            >
              ✕
            </button>
          </span>
        )}
        {catName && (
          <span className="chip">
            {catName}
            <button
              className="link"
              onClick={() => {
                const next = new URLSearchParams(params);
                next.delete('category');
                setParams(next);
              }}
              aria-label="Clear category filter"
            >
              ✕
            </button>
          </span>
        )}
        <label className="row small" style={{ gap: 4 }} title="When you pick a category, remember it for this merchant so future imports are categorised automatically">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => {
              setRemember(e.target.checked);
              try {
                localStorage.setItem(REMEMBER_KEY, e.target.checked ? '1' : '0');
              } catch {
                // ignore
              }
            }}
          />
          Remember merchant
        </label>
        <span className="spacer" />
        <AddTransaction accounts={accounts} categories={categories} onAdded={load} />
      </div>

      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Description</th>
                <th>Category</th>
                <th className="num">Amount</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {txs.map((t) => (
                <Fragment key={t.id}>
                  <tr className={`clickable${expanded === t.id ? ' expanded' : ''}`} onClick={() => setExpanded(expanded === t.id ? null : t.id)}>
                    <td className="small" style={{ whiteSpace: 'nowrap' }}>
                      {shortDate(t.date)}
                    </td>
                    <td>
                      <div style={{ opacity: t.ignored ? 0.5 : 1 }}>{t.description}</div>
                      {accounts.length > 1 && <div className="small muted">{t.account_name}</div>}
                      {t.payment_plan_name && <div className="small muted">💳 {t.payment_plan_name}</div>}
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      {t.splits.length > 1 ? (
                        <button className="link small" onClick={() => setExpanded(t.id)}>
                          Split: {t.splits.map((s) => s.category_name).join(', ')}
                        </button>
                      ) : (
                        <CategorySelect
                          categories={categories}
                          value={t.splits[0]?.category_id ?? null}
                          onChange={(id) => quickCategorize(t, id)}
                        />
                      )}
                    </td>
                    <td className={`num ${t.amount > 0 ? 'pos' : 'neg'}`}>{money(t.amount, { signed: true })}</td>
                    <td>
                      <StatusChip status={t.status} />
                      {t.status === 'needs_slip' && (
                        <div onClick={(e) => e.stopPropagation()}>
                          <select
                            className="small"
                            value=""
                            aria-label="Skip the slip"
                            onChange={(e) =>
                              e.target.value &&
                              api
                                .patchTransaction(t.id, { no_slip_reason: e.target.value as NoSlipReason })
                                .then(load)
                                .catch((err) => setError(err.message))
                            }
                          >
                            <option value="">Skip slip…</option>
                            <option value="lost">Slip lost</option>
                            <option value="single_category">
                              {t.splits.length === 1 ? `All ${t.splits[0].category_name}` : 'No split needed'}
                            </option>
                          </select>
                        </div>
                      )}
                      {t.status === 'reconciled' && t.no_slip_reason && !t.receipt_id ? (
                        <div className="small muted">no slip · {NO_SLIP_LABEL[t.no_slip_reason]}</div>
                      ) : null}
                      {t.provisional ? (
                        <div className="small muted" title="From a phone notification — replaced by the statement line when you import it">
                          📱 provisional
                        </div>
                      ) : null}
                    </td>
                  </tr>
                  {expanded === t.id && (
                    <tr className="expanded">
                      <td colSpan={5}>
                        <Detail tx={t} categories={categories} plans={plans} goals={goals} onChanged={load} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        {!loading && txs.length === 0 && (
          <div className="empty">
            Nothing here for this period. <Link to="/import">Import a statement</Link>
          </div>
        )}
      </div>
      {txs.length > 0 && (
        <p className="small muted">
          {txs.length} transactions · in {money(totalIn)} · out {money(totalOut)}
        </p>
      )}
    </>
  );
}
