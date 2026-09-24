import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import CategorySelect, { withChildren } from '../components/CategorySelect';
import { money, shortDate } from '../format';
import { Account, Category, CategoryGroup, Keyword, Merchant } from '../types';
import ConfirmButton from '../components/ConfirmButton';

type Tab = 'accounts' | 'categories' | 'members' | 'groups' | 'merchants' | 'keywords';
const TABS: [Tab, string][] = [
  ['accounts', 'Accounts'],
  ['categories', 'Categories'],
  ['members', 'Spending money'],
  ['groups', 'Groups'],
  ['merchants', 'Merchant rules'],
  ['keywords', 'Slip keywords'],
];

function Accounts({ onError }: { onError: (m: string) => void }) {
  const [list, setList] = useState<Account[]>([]);
  const blank = { name: '', bank: 'fnb', type: 'cheque', match_hint: '', flip_sign: 0 };
  const [f, setF] = useState<Partial<Account>>(blank);
  const [editing, setEditing] = useState<string | null>(null);
  const load = () => api.accounts().then(setList).catch((e) => onError(e.message));
  useEffect(() => {
    load();
  }, []);

  const save = () =>
    (editing ? api.updateAccount(editing, f) : api.createAccount(f))
      .then(() => {
        setF(blank);
        setEditing(null);
        load();
      })
      .catch((e) => onError(e.message));

  return (
    <>
      <div className="card">
        <h2>{editing ? 'Edit account' : 'Add an account'}</h2>
        <div className="form-grid">
          <label className="field">
            Name
            <input value={f.name ?? ''} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="FNB Cheque" />
          </label>
          <label className="field">
            Bank
            <select value={f.bank} onChange={(e) => setF({ ...f, bank: e.target.value })}>
              <option value="fnb">FNB</option>
              <option value="discovery">Discovery Bank</option>
              <option value="other">Other</option>
            </select>
          </label>
          <label className="field">
            Type
            <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
              <option value="cheque">Cheque / transactional</option>
              <option value="credit">Credit card</option>
              <option value="savings">Savings</option>
              <option value="cash">Cash</option>
            </select>
          </label>
          <label className="field">
            Account number (match hint)
            <input
              value={f.match_hint ?? ''}
              onChange={(e) => setF({ ...f, match_hint: e.target.value })}
              placeholder="62812345678 or last 4+ digits"
            />
          </label>
          <label className="row small" style={{ gap: 4 }}>
            <input type="checkbox" checked={Boolean(f.flip_sign)} onChange={(e) => setF({ ...f, flip_sign: e.target.checked ? 1 : 0 })} />
            Export shows purchases as positive (flip signs)
          </label>
        </div>
        <div className="row" style={{ marginTop: '0.75rem' }}>
          <button className="primary" onClick={save}>
            {editing ? 'Save' : 'Add account'}
          </button>
          {editing && (
            <button
              onClick={() => {
                setEditing(null);
                setF(blank);
              }}
            >
              Cancel
            </button>
          )}
        </div>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Account</th>
              <th>Match hint</th>
              <th className="num">Transactions</th>
              <th>Latest</th>
              <th className="num">Balance</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((a) => (
              <tr key={a.id}>
                <td>
                  {a.name} <span className="small muted">{a.bank} · {a.type}</span>
                </td>
                <td className="small">{a.match_hint ?? '—'}</td>
                <td className="num">{a.transaction_count}</td>
                <td className="small">{shortDate(a.last_transaction_date)}</td>
                <td className="num">{money(a.last_balance)}</td>
                <td className="row" style={{ justifyContent: 'flex-end' }}>
                  <button
                    className="link"
                    onClick={() => {
                      setEditing(a.id);
                      setF(a);
                    }}
                  >
                    Edit
                  </button>
                  <ConfirmButton
                    className="link danger"
                    question={`Delete ${a.name} and all ${a.transaction_count} of its transactions?`}
                    yes="Delete"
                    onConfirm={() => api.deleteAccount(a.id).then(load).catch((e) => onError(e.message))}
                  >
                    Delete
                  </ConfirmButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.length === 0 && <div className="empty">No accounts yet.</div>}
      </div>
    </>
  );
}

function Groups({ onError }: { onError: (m: string) => void }) {
  const [list, setList] = useState<CategoryGroup[]>([]);
  const [cats, setCats] = useState<Category[]>([]);
  const [newName, setNewName] = useState('');
  const load = () => {
    api.groups().then(setList).catch((e) => onError(e.message));
    api.categories().then(setCats).catch(() => undefined);
  };
  useEffect(load, []);

  // Swap sort positions with the neighbour; renumbers so orders stay distinct.
  const move = async (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    try {
      await Promise.all(next.map((g, k) => api.updateGroup(g.id, { name: g.name, sort_order: k })));
      load();
    } catch (e) {
      onError((e as Error).message);
    }
  };

  return (
    <>
      <div className="card">
        <p className="small muted" style={{ marginTop: 0 }}>
          Groups bundle spending categories for the dashboard and plan — e.g. <em>Fixed</em> (bond, rates, insurance),{' '}
          <em>Living</em> (groceries, fuel, kids), <em>Lifestyle</em> (eating out, entertainment) — each with its own subtotal
          and Home Assistant sensor. Budgets and reconciling stay per category. Pick a category’s group on the Categories tab.
        </p>
        <div className="row">
          <input placeholder="New group" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <button
            className="primary"
            onClick={() =>
              newName.trim() &&
              api
                .createGroup(newName.trim())
                .then(() => {
                  setNewName('');
                  load();
                })
                .catch((e) => onError(e.message))
            }
          >
            Add
          </button>
        </div>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <table>
          <tbody>
            {list.map((g, i) => (
              <tr key={g.id}>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="link" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">
                    ▲
                  </button>{' '}
                  <button className="link" onClick={() => move(i, 1)} disabled={i === list.length - 1} aria-label="Move down">
                    ▼
                  </button>
                </td>
                <td>
                  <input
                    defaultValue={g.name}
                    onBlur={(e) =>
                      e.target.value.trim() &&
                      e.target.value !== g.name &&
                      api.updateGroup(g.id, { name: e.target.value.trim(), sort_order: g.sort_order }).then(load).catch((er) => onError(er.message))
                    }
                  />
                </td>
                <td className="small muted">
                  {cats
                    .filter((c) => c.group_id === g.id && !c.archived)
                    .map((c) => `${c.icon ?? ''} ${c.name}`.trim())
                    .join(', ') || 'No categories yet'}
                </td>
                <td>
                  <ConfirmButton
                    className="link danger small"
                    question={`Delete “${g.name}”? Its categories become ungrouped.`}
                    yes="Delete"
                    onConfirm={() => api.deleteGroup(g.id).then(load).catch((e) => onError(e.message))}
                  >
                    Delete
                  </ConfirmButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.length === 0 && <div className="empty">No groups yet.</div>}
      </div>
    </>
  );
}

function Categories({ onError }: { onError: (m: string) => void }) {
  const [list, setList] = useState<Category[]>([]);
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState('expense');
  const [newParent, setNewParent] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [groups, setGroups] = useState<CategoryGroup[]>([]);
  const load = () => api.categories().then(setList).catch((e) => onError(e.message));
  useEffect(() => {
    load();
    api.groups().then(setGroups).catch(() => undefined);
  }, []);

  const patch = (c: Category, p: Partial<Category>) =>
    api
      .updateCategory(c.id, { ...c, ...p })
      .then(load)
      .catch((e) => onError(e.message));

  return (
    <>
      <div className="card">
        <div className="row">
          <input placeholder="New category" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <select value={newParent} onChange={(e) => setNewParent(e.target.value)} aria-label="Subcategory of">
            <option value="">Top level</option>
            {list
              .filter((c) => !c.parent_id && !c.archived && c.kind !== 'transfer')
              .map((c) => (
                <option key={c.id} value={c.id}>
                  under {c.icon} {c.name}
                </option>
              ))}
          </select>
          <select value={newKind} onChange={(e) => setNewKind(e.target.value)} disabled={Boolean(newParent)}>
            <option value="expense">Expense</option>
            <option value="income">Income</option>
            <option value="savings">Savings</option>
            <option value="transfer">Transfer (not counted)</option>
          </select>
          <button
            className="primary"
            onClick={() =>
              newName.trim() &&
              api
                .createCategory({
                  name: newName.trim(),
                  kind: newKind as Category['kind'],
                  parent_id: newParent || null,
                  // A subcategory needs a slip if its parent does.
                  requires_slip: list.find((c) => c.id === newParent)?.requires_slip ?? 0,
                })
                .then((c) => {
                  setNewName('');
                  const added = (c as Category & { keywords_added?: number }).keywords_added;
                  setMsg(added ? `${c.name} added with ${added} starter slip keywords (Setup → Slip keywords).` : null);
                  load();
                })
                .catch((e) => onError(e.message))
            }
          >
            Add
          </button>
        </div>
        <p className="small muted" style={{ marginBottom: 0 }}>
          <strong>Subcategories</strong> (Top level → “under Groceries”) split a category further: Meat, Starch, … Slip lines go to
          them by keyword or product, and the parent’s figures include them. Meat, Starch, Fruit &amp; Veg, Kitchen and Snacks &amp; Sweets
          come with starter keywords.{' '}
          <strong>Slip required</strong> marks the “smart” categories: a transaction in one of them stays <em>Needs slip</em> until a
          till slip is attached, and the slip’s lines decide how it’s split (a Checkers run → Groceries + Kids + Medical).
        </p>
      </div>
      {msg && (
        <div className="notice" onClick={() => setMsg(null)}>
          {msg}
        </div>
      )}
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Icon</th>
                <th>Name</th>
                <th>Subcategory of</th>
                <th>Kind</th>
                <th>Group</th>
                <th>Slip required</th>
                <th>Colour</th>
                <th>Archived</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {withChildren(list).map((c) => (
                <tr key={c.id} className={c.parent_id ? 'sub-row' : undefined} style={{ opacity: c.archived ? 0.55 : 1 }}>
                  <td>
                    <input defaultValue={c.icon ?? ''} style={{ width: '3rem' }} onBlur={(e) => e.target.value !== (c.icon ?? '') && patch(c, { icon: e.target.value })} />
                  </td>
                  <td>
                    <input defaultValue={c.name} onBlur={(e) => e.target.value !== c.name && patch(c, { name: e.target.value })} />
                  </td>
                  <td>
                    {list.some((x) => x.parent_id === c.id) ? (
                      <button
                        className="small"
                        title="Move slip lines still in this category into its subcategories, by keyword"
                        onClick={() =>
                          api
                            .resortCategory(c.id)
                            .then((r) => setMsg(`Moved ${r.lines} slip line(s) into subcategories; ${r.receipts} transaction(s) re-split.`))
                            .catch((e) => onError(e.message))
                        }
                      >
                        Re-sort slip lines
                      </button>
                    ) : (
                      <select value={c.parent_id ?? ''} onChange={(e) => patch(c, { parent_id: e.target.value || null })} aria-label="Subcategory of">
                        <option value="">—</option>
                        {list
                          .filter((p) => p.id !== c.id && !p.parent_id && p.kind !== 'transfer' && (!p.archived || p.id === c.parent_id))
                          .map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.icon} {p.name}
                            </option>
                          ))}
                      </select>
                    )}
                  </td>
                  <td>
                    <select value={c.kind} disabled={Boolean(c.parent_id)} onChange={(e) => patch(c, { kind: e.target.value as Category['kind'] })}>
                      <option value="expense">Expense</option>
                      <option value="income">Income</option>
                      <option value="savings">Savings</option>
                      <option value="transfer">Transfer</option>
                    </select>
                  </td>
                  <td>
                    {c.kind === 'expense' ? (
                      <select value={c.group_id ?? ''} onChange={(e) => patch(c, { group_id: e.target.value || null })} aria-label="Group" disabled={Boolean(c.parent_id)} title={c.parent_id ? "A subcategory is in its parent’s group" : undefined}>
                        <option value="">—</option>
                        {groups.map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="small muted">—</span>
                    )}
                  </td>
                  <td>
                    <input type="checkbox" checked={Boolean(c.requires_slip)} onChange={(e) => patch(c, { requires_slip: e.target.checked ? 1 : 0 })} />
                  </td>
                  <td>
                    <input type="color" value={c.color ?? '#898781'} onChange={(e) => patch(c, { color: e.target.value })} style={{ padding: 0, width: '2.2rem', height: '1.8rem' }} />
                  </td>
                  <td>
                    <input type="checkbox" checked={Boolean(c.archived)} onChange={(e) => patch(c, { archived: e.target.checked ? 1 : 0 })} />
                  </td>
                  <td>
                    <ConfirmButton
                      className="link danger small"
                      question={`Delete ${c.name}?`}
                      yes="Delete"
                      onConfirm={() => api.deleteCategory(c.id).then(load).catch((e) => onError(e.message))}
                    >
                      Delete
                    </ConfirmButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

/** Household members' spending money: each member is a personal category
 *  whose budget is their allowance. Anything allocated to it — a whole
 *  transaction or one line on a slip — counts against their allowance. */
function Members({ onError }: { onError: (m: string) => void }) {
  const [list, setList] = useState<Category[]>([]);
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const load = () =>
    api
      .categories()
      .then((cs) => setList(cs.filter((c) => c.personal)))
      .catch((e) => onError(e.message));
  useEffect(() => {
    load();
  }, []);

  const patch = (c: Category, p: Partial<Category>) =>
    api
      .updateCategory(c.id, { ...c, ...p })
      .then(load)
      .catch((e) => onError(e.message));

  return (
    <>
      <div className="card">
        <p className="small" style={{ marginTop: 0 }}>
          Everyone in the household gets their own spending money. Each person here is a category in the <strong>Personal</strong>{' '}
          group: put a transaction (or a single line on a slip) in their name and it comes off their allowance. The dashboard shows
          what each person has left.
        </p>
        <div className="row">
          <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
          <input
            type="number"
            inputMode="decimal"
            placeholder="Spending money per period"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            style={{ width: '14rem' }}
          />
          <button
            className="primary"
            onClick={() =>
              name.trim() &&
              api
                .createCategory({ name: name.trim(), kind: 'expense', icon: '👤', personal: 1, default_budget: parseFloat(amount) || 0 })
                .then(() => {
                  setName('');
                  setAmount('');
                  load();
                })
                .catch((e) => onError(e.message))
            }
          >
            Add person
          </button>
        </div>
      </div>
      {list.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Icon</th>
                  <th>Name</th>
                  <th className="num">Spending money</th>
                  <th>Archived</th>
                </tr>
              </thead>
              <tbody>
                {list.map((c) => (
                  <tr key={c.id} style={{ opacity: c.archived ? 0.55 : 1 }}>
                    <td>
                      <input defaultValue={c.icon ?? ''} style={{ width: '3rem' }} onBlur={(e) => e.target.value !== (c.icon ?? '') && patch(c, { icon: e.target.value })} />
                    </td>
                    <td>
                      <input defaultValue={c.name} onBlur={(e) => e.target.value !== c.name && patch(c, { name: e.target.value })} />
                    </td>
                    <td className="num">
                      <input
                        type="number"
                        inputMode="decimal"
                        defaultValue={c.default_budget || ''}
                        style={{ width: '8rem', textAlign: 'right' }}
                        onBlur={(e) => (parseFloat(e.target.value) || 0) !== c.default_budget && patch(c, { default_budget: parseFloat(e.target.value) || 0 })}
                      />
                    </td>
                    <td>
                      <input type="checkbox" checked={Boolean(c.archived)} onChange={(e) => patch(c, { archived: e.target.checked ? 1 : 0 })} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="small muted" style={{ margin: '0.5rem 0.75rem' }}>
            The amount is the default for every period; change one period’s amount (a birthday month) on the Plan page.
          </p>
        </div>
      )}
    </>
  );
}

function Merchants({ onError }: { onError: (m: string) => void }) {
  const [list, setList] = useState<Merchant[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [f, setF] = useState<Partial<Merchant>>({ name: '', patterns: '', default_category_id: null });
  const [msg, setMsg] = useState<string | null>(null);
  const load = () => api.merchants().then(setList).catch((e) => onError(e.message));
  useEffect(() => {
    load();
    api.categories().then(setCategories).catch(() => undefined);
  }, []);

  return (
    <>
      {msg && (
        <div className="notice" onClick={() => setMsg(null)}>
          {msg}
        </div>
      )}
      <div className="card">
        <h2>Add a rule</h2>
        <p className="small muted" style={{ marginTop: 0 }}>
          A statement line containing any pattern (separate with <code>|</code>) is assigned the merchant and its category. The
          longest matching pattern wins. Choosing a category on the Transactions page with “Remember merchant” ticked creates these
          for you.
        </p>
        <div className="form-grid">
          <label className="field">
            Merchant
            <input value={f.name ?? ''} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Checkers" />
          </label>
          <label className="field">
            Patterns
            <input value={f.patterns ?? ''} onChange={(e) => setF({ ...f, patterns: e.target.value })} placeholder="CHECKERS|CHECKERS HYPER" />
          </label>
          <label className="field">
            Category
            <CategorySelect categories={categories} value={f.default_category_id ?? null} onChange={(id) => setF({ ...f, default_category_id: id })} />
          </label>
          <button
            className="primary"
            onClick={() =>
              api
                .createMerchant(f)
                .then((r) => {
                  setMsg(`Rule added — ${r.applied} uncategorised transaction(s) matched.`);
                  setF({ name: '', patterns: '', default_category_id: null });
                  load();
                })
                .catch((e) => onError(e.message))
            }
          >
            Add rule
          </button>
        </div>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Merchant</th>
                <th>Patterns</th>
                <th>Category</th>
                <th className="num">Matched</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((m) => (
                <tr key={m.id}>
                  <td>{m.name}</td>
                  <td>
                    <input
                      defaultValue={m.patterns}
                      onBlur={(e) =>
                        e.target.value !== m.patterns &&
                        api
                          .updateMerchant(m.id, { ...m, patterns: e.target.value })
                          .then(load)
                          .catch((er) => onError(er.message))
                      }
                      style={{ width: '100%', minWidth: 180 }}
                    />
                  </td>
                  <td>
                    <CategorySelect
                      categories={categories}
                      value={m.default_category_id}
                      placeholder="None"
                      onChange={(id) =>
                        api
                          .updateMerchant(m.id, { ...m, default_category_id: id })
                          .then(load)
                          .catch((e) => onError(e.message))
                      }
                    />
                  </td>
                  <td className="num">{m.transaction_count}</td>
                  <td>
                    <button className="link danger small" onClick={() => api.deleteMerchant(m.id).then(load).catch((e) => onError(e.message))}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function Keywords({ onError }: { onError: (m: string) => void }) {
  const [list, setList] = useState<Keyword[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [kw, setKw] = useState('');
  const [cat, setCat] = useState<string | null>(null);
  const load = () => api.keywords().then(setList).catch((e) => onError(e.message));
  useEffect(() => {
    load();
    api.categories().then(setCategories).catch(() => undefined);
  }, []);
  return (
    <>
      <div className="card">
        <p className="small muted" style={{ marginTop: 0 }}>
          For slip lines that aren’t in the product database yet: a line containing the keyword gets that category instead of the
          shop’s default. Once you correct a line, the product itself remembers — keywords are just the first guess.
        </p>
        <div className="row">
          <input placeholder="Keyword, e.g. HUGGIES" value={kw} onChange={(e) => setKw(e.target.value)} />
          <CategorySelect categories={categories} value={cat} onChange={setCat} kinds={['expense', 'savings']} />
          <button
            className="primary"
            onClick={() =>
              kw &&
              cat &&
              api
                .createKeyword(kw, cat)
                .then(() => {
                  setKw('');
                  load();
                })
                .catch((e) => onError(e.message))
            }
          >
            Add
          </button>
        </div>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <table>
          <tbody>
            {list.map((k) => (
              <tr key={k.id}>
                <td>
                  <code>{k.keyword}</code>
                </td>
                <td>{k.category_name}</td>
                <td>
                  <button className="link danger small" onClick={() => api.deleteKeyword(k.id).then(load)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export default function Setup() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'accounts';
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <h1>Setup</h1>
      <div className="tabs">
        {TABS.map(([t, label]) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => (setError(null), setParams({ tab: t }))}>
            {label}
          </button>
        ))}
      </div>
      {error && (
        <div className="error" onClick={() => setError(null)}>
          {error}
        </div>
      )}
      {tab === 'accounts' && <Accounts onError={setError} />}
      {tab === 'categories' && <Categories onError={setError} />}
      {tab === 'members' && <Members onError={setError} />}
      {tab === 'groups' && <Groups onError={setError} />}
      {tab === 'merchants' && <Merchants onError={setError} />}
      {tab === 'keywords' && <Keywords onError={setError} />}
    </>
  );
}
