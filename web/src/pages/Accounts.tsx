import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { PeriodPicker, usePeriod } from '../components/PeriodContext';
import { money } from '../format';
import { AccountBreakdown, AccountSpend, PayMethod } from '../types';

export const METHOD_LABEL: Record<PayMethod, string> = {
  card: 'Card',
  debit_order: 'Debit order',
  eft: 'EFT / app payment',
  cash: 'Cash',
  charges: 'Bank charges & interest',
  transfer: 'Transfer',
  other: 'Other / refunds',
};

/** Spending by payment method as one bar, widths by share. */
function MethodBar({ a, methods }: { a: AccountSpend; methods: PayMethod[] }) {
  const used = methods.filter((m) => a.by_method[m] > 0.009);
  const total = used.reduce((s, m) => s + a.by_method[m], 0);
  if (!total) return null;
  return (
    <>
      <div className="method-bar" role="img" aria-label="Spending by payment method">
        {used.map((m) => (
          <div
            key={m}
            className={`method-seg m-${m}`}
            style={{ flexGrow: a.by_method[m] }}
            title={`${METHOD_LABEL[m]}: ${money(a.by_method[m])} (${Math.round((a.by_method[m] / total) * 100)}%)`}
          />
        ))}
      </div>
      <div className="method-legend small">
        {used.map((m) => (
          <span key={m}>
            <i className={`swatch m-${m}`} /> {METHOD_LABEL[m]} <strong>{money(a.by_method[m], { whole: true })}</strong>{' '}
            <span className="muted">{Math.round((a.by_method[m] / total) * 100)}%</span>
          </span>
        ))}
      </div>
    </>
  );
}

function AccountCard({ a, methods }: { a: AccountSpend; methods: PayMethod[] }) {
  // Only the methods this account used get a column.
  const cols = methods.filter((m) => a.categories.some((c) => Math.abs(c.methods[m]) > 0.009));
  return (
    <div className="card">
      <div className="row" style={{ alignItems: 'baseline', marginBottom: '0.5rem' }}>
        <h2 style={{ margin: 0 }}>{a.name}</h2>
        <span className="small muted">
          {a.type}
          {a.owner_name ? ` · ${a.owner_name}'s` : ''}
        </span>
        <span className="spacer" />
        <span className="small muted">spent</span>
        <strong>{money(a.spending, { whole: true })}</strong>
      </div>
      <p className="small muted" style={{ marginTop: 0 }}>
        In {money(a.money_in, { whole: true })} · out {money(a.money_out, { whole: true })}
        {a.income ? ` · income ${money(a.income, { whole: true })}` : ''}
        {Math.abs(a.transfers_out) > 0.5 ? ` · transfers ${money(a.transfers_out, { whole: true, signed: true })}` : ''}
      </p>
      <MethodBar a={a} methods={methods} />
      {a.categories.length > 0 ? (
        <div className="table-wrap" style={{ marginTop: '0.75rem' }}>
          <table>
            <thead>
              <tr>
                <th>Category</th>
                {cols.map((m) => (
                  <th key={m} className="num">
                    <i className={`swatch m-${m}`} /> {METHOD_LABEL[m]}
                  </th>
                ))}
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {a.categories.map((c) => (
                <tr key={c.category_id ?? 'none'}>
                  <td>
                    <Link to={`/transactions?account=${a.account_id}${c.category_id ? `&category=${c.category_id}` : '&status=uncategorized'}`}>
                      {c.icon ? `${c.icon} ` : ''}
                      {c.name}
                    </Link>
                  </td>
                  {cols.map((m) => (
                    <td key={m} className="num">
                      {Math.abs(c.methods[m]) > 0.009 ? money(c.methods[m]) : <span className="muted">—</span>}
                    </td>
                  ))}
                  <td className="num">
                    <strong>{money(c.total)}</strong>
                  </td>
                </tr>
              ))}
              <tr className="total-row">
                <td>
                  <strong>Total</strong>
                </td>
                {cols.map((m) => (
                  <td key={m} className="num">
                    <strong>{money(a.by_method[m])}</strong>
                  </td>
                ))}
                <td className="num">
                  <strong>{money(a.spending)}</strong>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : (
        <p className="small muted">No spending on this account this period — only transfers and income.</p>
      )}
    </div>
  );
}

export default function Accounts() {
  const { selected } = usePeriod();
  const [data, setData] = useState<AccountBreakdown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [only, setOnly] = useState<string>('');

  useEffect(() => {
    if (selected) api.accountBreakdown(selected.start).then(setData).catch((e) => setError(e.message));
  }, [selected?.start]);

  const shown = data?.accounts.filter((a) => !only || a.account_id === only) ?? [];
  return (
    <>
      <div className="page-head">
        <h1>Accounts</h1>
        <PeriodPicker />
      </div>
      {error && (
        <div className="error" onClick={() => setError(null)}>
          {error}
        </div>
      )}
      <p className="small muted">
        What went out of each account this period, by category and how it was paid. Transfers between your own accounts and card
        repayments aren’t spending, so they’re left out of the tables.
      </p>
      {data && data.accounts.length > 1 && (
        <div className="row" style={{ marginBottom: '0.75rem', flexWrap: 'wrap' }}>
          <button className={only ? '' : 'primary'} onClick={() => setOnly('')}>
            All
          </button>
          {data.accounts.map((a) => (
            <button key={a.account_id} className={only === a.account_id ? 'primary' : ''} onClick={() => setOnly(a.account_id)}>
              {a.name}
            </button>
          ))}
        </div>
      )}
      {shown.map((a) => (
        <AccountCard key={a.account_id} a={a} methods={data!.methods} />
      ))}
      {data && data.accounts.length === 0 && <div className="card empty">Nothing on any account this period yet.</div>}
    </>
  );
}
