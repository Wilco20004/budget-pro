import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import ConfirmButton from '../components/ConfirmButton';
import { PeriodPicker, usePeriod } from '../components/PeriodContext';
import { money, shortDate, todayIso } from '../format';
import { Account, Category, SavingsGoal, SavingsMovement, SavingsOverview } from '../types';

const STATUS: Record<SavingsGoal['status'], { text: string; color: string } | null> = {
  no_target: null,
  saving: null,
  reached: { text: '✓ Target reached', color: 'var(--good-text)' },
  on_track: { text: '✓ On track', color: 'var(--good-text)' },
  behind: { text: '▲ Behind', color: 'var(--warning-text)' },
};

interface Draft {
  id?: string;
  name: string;
  icon: string;
  physical: boolean;
  account_id: string;
  target: string;
  target_date: string;
  topup: string;
  category_id: string;
  opening_balance: string;
  match_pattern: string;
  archived: number;
}

function toDraft(g: SavingsGoal): Draft {
  return {
    id: g.id,
    name: g.name,
    icon: g.icon ?? '',
    physical: Boolean(g.tracks_account),
    account_id: g.account_id ?? '',
    target: g.target !== null ? String(g.target) : '',
    target_date: g.target_date ?? '',
    topup: g.topup ? String(g.topup) : '',
    category_id: g.category_id ?? '',
    opening_balance: g.opening_balance ? String(g.opening_balance) : '',
    match_pattern: g.match_pattern ?? '',
    archived: g.archived,
  };
}

function GoalForm({
  draft,
  setDraft,
  accounts,
  categories,
  onSave,
  onCancel,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  accounts: Account[];
  categories: Category[];
  onSave: () => void;
  onCancel: () => void;
}) {
  const set = (p: Partial<Draft>) => setDraft({ ...draft, ...p });
  return (
    <div className="card">
      <h2>{draft.id ? `Edit ${draft.name}` : 'New savings goal'}</h2>
      <div className="row small" style={{ gap: '1rem', marginBottom: '0.5rem' }}>
        <label className="row" style={{ gap: 4 }}>
          <input type="radio" checked={!draft.physical} onChange={() => set({ physical: false })} />
          A pot in a shared account (virtual)
        </label>
        <label className="row" style={{ gap: 4 }}>
          <input type="radio" checked={draft.physical} onChange={() => set({ physical: true })} />
          Its own account (physical)
        </label>
      </div>
      <div className="form-grid">
        <label className="field">
          Name
          <input value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="December holiday" />
        </label>
        <label className="field">
          Icon
          <input value={draft.icon} onChange={(e) => set({ icon: e.target.value })} placeholder="🏖️" style={{ width: '4rem' }} />
        </label>
        <label className="field">
          {draft.physical ? 'Account' : 'Kept in (optional)'}
          <select value={draft.account_id} onChange={(e) => set({ account_id: e.target.value })}>
            <option value="">{draft.physical ? '— choose the account' : '— not in a particular account'}</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Target (optional)
          <input type="number" inputMode="decimal" value={draft.target} onChange={(e) => set({ target: e.target.value })} />
        </label>
        <label className="field">
          Target date (optional)
          <input type="date" value={draft.target_date} onChange={(e) => set({ target_date: e.target.value })} />
        </label>
        <label className="field">
          Planned top-up per period
          <input type="number" inputMode="decimal" value={draft.topup} onChange={(e) => set({ topup: e.target.value })} />
        </label>
        <label className="field">
          Count the top-up in budget category
          <select value={draft.category_id} onChange={(e) => set({ category_id: e.target.value })}>
            <option value="">— not in the budget</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.icon} {c.name}
              </option>
            ))}
          </select>
        </label>
        {!draft.physical && (
          <>
            <label className="field">
              Already saved
              <input type="number" inputMode="decimal" value={draft.opening_balance} onChange={(e) => set({ opening_balance: e.target.value })} />
            </label>
            <label className="field">
              Statement text (optional)
              <input value={draft.match_pattern} onChange={(e) => set({ match_pattern: e.target.value })} placeholder="HOLIDAY POCKET" />
            </label>
          </>
        )}
      </div>
      <p className="small muted">
        {draft.physical
          ? 'The balance is the account’s balance from its imported statements. Until one is imported, top-ups entered here count.'
          : 'The balance is what’s already saved plus top-ups and withdrawals. Share a transfer over pots from the transaction’s details, or add them here. Bank lines containing the statement text are added automatically.'}{' '}
        The planned top-up is added to the category’s budget each period until the target is reached.
      </p>
      <div className="row">
        {draft.id && (
          <label className="row small" style={{ gap: 4 }}>
            <input type="checkbox" checked={Boolean(draft.archived)} onChange={(e) => set({ archived: e.target.checked ? 1 : 0 })} />
            Archived (done — stops the planned top-up)
          </label>
        )}
        <button className="primary" onClick={onSave}>
          {draft.id ? 'Save goal' : 'Add goal'}
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function History({ goal, onChanged }: { goal: SavingsGoal; onChanged: () => void }) {
  const [list, setList] = useState<SavingsMovement[] | null>(null);
  const load = () => api.goalMovements(goal.id).then(setList).catch(() => setList([]));
  useEffect(() => {
    load();
  }, [goal.id, goal.balance]);
  if (!list) return null;
  if (!list.length) return <div className="small muted">No top-ups or withdrawals yet.</div>;
  return (
    <table className="small">
      <tbody>
        {list.map((m) => (
          <tr key={m.id}>
            <td style={{ whiteSpace: 'nowrap' }}>{shortDate(m.date)}</td>
            <td>
              {m.note ?? m.transaction_description ?? ''}
              {m.source === 'auto' && <span className="muted"> · statement text</span>}
            </td>
            <td className="num" style={{ color: m.amount < 0 ? 'var(--critical-text)' : 'var(--good-text)' }}>
              {money(m.amount, { signed: true })}
            </td>
            <td>
              <ConfirmButton
                className="link small danger"
                question="Remove it?"
                yes="Remove"
                onConfirm={() =>
                  api
                    .deleteMovement(m.id)
                    .then(() => {
                      load();
                      onChanged();
                    })
                    .catch(() => undefined)
                }
              >
                ✕
              </ConfirmButton>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function GoalRow({ g, onEdit, onChanged, onError }: { g: SavingsGoal; onEdit: () => void; onChanged: () => void; onError: (m: string) => void }) {
  const [moving, setMoving] = useState<null | 1 | -1>(null);
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(todayIso());
  const [note, setNote] = useState('');
  const [open, setOpen] = useState(false);
  const status = STATUS[g.status];
  const fromAccount = g.balance_source === 'account';

  async function saveMove() {
    const n = parseFloat(amount);
    if (!n || !moving) return;
    try {
      await api.addMovement(g.id, { amount: Math.abs(n) * moving, date, note: note.trim() || null });
      setMoving(null);
      setAmount('');
      setNote('');
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    }
  }

  return (
    <div className="goal" style={{ opacity: g.archived ? 0.55 : 1 }}>
      <div className="row" style={{ alignItems: 'baseline' }}>
        <strong>
          {g.icon} {g.name}
        </strong>
        <span className="small muted">{g.kind === 'physical' ? 'own account' : 'pot'}</span>
        <span className="spacer" />
        <span>
          <strong>{money(g.balance, { whole: true })}</strong>
          {g.target !== null && <span className="muted"> / {money(g.target, { whole: true })}</span>}
        </span>
      </div>
      {g.target !== null && (
        <div
          className="goal-bar"
          role="img"
          aria-label={`${g.pct ?? 0}% of target`}
          title={`${money(g.balance)} of ${money(g.target)} (${(g.pct ?? 0).toFixed(0)}%)`}
        >
          <div className="goal-fill" style={{ width: `${Math.max(0, g.pct ?? 0)}%` }} />
        </div>
      )}
      <div className="small muted">
        {status && <span style={{ color: status.color }}>{status.text} · </span>}
        {g.remaining ? `${money(g.remaining, { whole: true })} to go` : ''}
        {g.target_date ? ` by ${shortDate(g.target_date)}` : ''}
        {g.needed_per_period !== null && g.remaining ? ` · needs ${money(g.needed_per_period, { whole: true })} per period` : ''}
        {g.topup ? ` · planned ${money(g.topup, { whole: true })} per period` : ''}
      </div>
      <div className="small">
        This period: <span style={{ color: 'var(--good-text)' }}>+{money(g.this_period.added, { whole: true })}</span>
        {g.this_period.withdrawn > 0 && <span style={{ color: 'var(--critical-text)' }}> −{money(g.this_period.withdrawn, { whole: true })}</span>}
        {fromAccount && g.account_id && (
          <>
            {' · '}
            <Link to={`/transactions?account=${g.account_id}`}>from {g.account_name}’s statements</Link>
          </>
        )}
      </div>
      <div className="row small" style={{ gap: 6, marginTop: 4 }}>
        {!fromAccount && (
          <>
            <button className="small" onClick={() => setMoving(moving === 1 ? null : 1)}>
              + Top up
            </button>
            <button className="small" onClick={() => setMoving(moving === -1 ? null : -1)}>
              − Withdraw
            </button>
            <button className="small" onClick={() => setOpen(!open)}>
              {open ? 'Hide history' : 'History'}
            </button>
          </>
        )}
        <button className="small" onClick={onEdit}>
          Edit
        </button>
        <ConfirmButton
          className="small danger"
          question={`Delete ${g.name} and its history? Transactions stay as they are.`}
          yes="Delete"
          onConfirm={() => api.deleteGoal(g.id).then(onChanged).catch((e) => onError(e.message))}
        >
          Delete
        </ConfirmButton>
      </div>
      {moving && (
        <div className="row" style={{ marginTop: 6 }}>
          <input type="number" inputMode="decimal" placeholder={moving > 0 ? 'Top-up amount' : 'Withdrawal amount'} value={amount} onChange={(e) => setAmount(e.target.value)} style={{ width: '9rem' }} />
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <input placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="primary small" onClick={saveMove}>
            Save
          </button>
        </div>
      )}
      {open && <History goal={g} onChanged={onChanged} />}
    </div>
  );
}

export default function Savings() {
  const { selected } = usePeriod();
  const [o, setO] = useState<SavingsOverview | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    if (!selected) return;
    api
      .savings(selected.start, showArchived)
      .then(setO)
      .catch((e) => setError(e.message));
  };
  useEffect(load, [selected?.start, showArchived]);
  useEffect(() => {
    api.accounts().then(setAccounts).catch(() => undefined);
    api.categories().then(setCategories).catch(() => undefined);
  }, []);

  const savingsCats = categories.filter((c) => c.kind === 'savings' && !c.archived);
  const newDraft = (): Draft => ({
    name: '',
    icon: '',
    physical: false,
    account_id: accounts.find((a) => a.type === 'savings')?.id ?? '',
    target: '',
    target_date: '',
    topup: '',
    category_id: savingsCats[0]?.id ?? '',
    opening_balance: '',
    match_pattern: '',
    archived: 0,
  });

  async function save() {
    if (!draft) return;
    const body = {
      name: draft.name.trim(),
      icon: draft.icon.trim() || null,
      tracks_account: draft.physical ? 1 : 0,
      account_id: draft.account_id || null,
      target: draft.target ? parseFloat(draft.target) : null,
      target_date: draft.target_date || null,
      topup: parseFloat(draft.topup) || 0,
      category_id: draft.category_id || null,
      opening_balance: draft.physical ? 0 : parseFloat(draft.opening_balance) || 0,
      match_pattern: draft.physical ? null : draft.match_pattern.trim() || null,
      archived: draft.archived,
    };
    try {
      if (draft.id) await api.updateGoal(draft.id, body);
      else await api.createGoal(body);
      setDraft(null);
      setError(null);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const goals = o?.goals ?? [];
  const planned = goals.reduce((a, g) => a + g.planned_this_period, 0);
  const added = goals.reduce((a, g) => a + g.this_period.added - g.this_period.withdrawn, 0);
  const sections = [
    ...(o?.accounts ?? []).map((a) => ({ key: a.account_id, title: a.name, account: a, goals: goals.filter((g) => g.account_id === a.account_id) })),
    { key: 'none', title: 'Not in a particular account', account: null, goals: goals.filter((g) => !g.account_id) },
  ].filter((s) => s.goals.length);

  return (
    <>
      <div className="page-head">
        <h1>Savings</h1>
        <PeriodPicker />
      </div>
      {error && (
        <div className="error" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      <div className="tiles">
        <div className="tile">
          <div className="label">Saved in goals</div>
          <div className="value">{money(o?.total ?? 0, { whole: true })}</div>
          <div className="sub">
            {goals.length} goal{goals.length === 1 ? '' : 's'}
          </div>
        </div>
        <div className="tile">
          <div className="label">Put away this period</div>
          <div className="value">{money(added, { whole: true, signed: added !== 0 })}</div>
          <div className="sub">of {money(planned, { whole: true })} planned</div>
        </div>
      </div>

      {draft && <GoalForm draft={draft} setDraft={setDraft} accounts={accounts} categories={savingsCats} onSave={save} onCancel={() => setDraft(null)} />}

      {sections.map((s) => (
        <div className="card" key={s.key}>
          <div className="row" style={{ marginBottom: '0.5rem' }}>
            <h2 style={{ margin: 0 }}>{s.title}</h2>
            <span className="spacer" />
            {s.account?.balance !== null && s.account?.balance !== undefined && (
              <span className="small muted">balance {money(s.account.balance, { whole: true })}</span>
            )}
          </div>
          <div className="goals">
            {s.goals.map((g) => (
              <GoalRow key={g.id} g={g} onEdit={() => setDraft(toDraft(g))} onChanged={load} onError={setError} />
            ))}
          </div>
          {s.account && s.account.unassigned !== null && Math.abs(s.account.unassigned) > 0.5 && (
            <p className="small" style={{ marginBottom: 0, color: s.account.unassigned < 0 ? 'var(--critical-text)' : 'var(--ink-2)' }}>
              {s.account.unassigned > 0
                ? `${money(s.account.unassigned, { whole: true })} in ${s.title} isn’t in a pot yet — top up a pot to assign it.`
                : `The pots add up to ${money(-s.account.unassigned, { whole: true })} more than ${s.title} holds.`}
            </p>
          )}
        </div>
      ))}

      {!goals.length && !draft && (
        <div className="card empty">
          No savings goals yet. A goal can be a pot inside a shared savings account (R1,000 of it for medical, R500 for the December
          holiday) or an account of its own.
        </div>
      )}

      <div className="row">
        {!draft && (
          <button className="primary" onClick={() => setDraft(newDraft())}>
            + Add savings goal
          </button>
        )}
        <span className="spacer" />
        <label className="row small" style={{ gap: 4 }}>
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Show archived
        </label>
      </div>
    </>
  );
}
