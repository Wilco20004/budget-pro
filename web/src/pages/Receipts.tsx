import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import ReceiptUpload from '../components/ReceiptUpload';
import { money, shortDate } from '../format';
import { ReceiptSummary } from '../types';

const STATUS: Record<string, string> = {
  pending: '⏳ Waiting',
  processing: '⏳ Reading…',
  parsed: '',
  failed: '✕ Failed',
};

export default function Receipts() {
  const [list, setList] = useState<ReceiptSummary[]>([]);
  const [unlinkedOnly, setUnlinkedOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const load = () => api.receipts(unlinkedOnly).then(setList).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, [unlinkedOnly]);

  // Poll while any slip is still being read.
  useEffect(() => {
    if (!list.some((r) => r.status === 'pending' || r.status === 'processing')) return;
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, [list]);

  return (
    <>
      <div className="page-head">
        <h1>Slips</h1>
        <Link to="/products">Product database →</Link>
      </div>
      {error && <div className="error">{error}</div>}
      <ReceiptUpload
        onUploaded={(ids) => {
          if (ids.length === 1) navigate(`/receipts/${ids[0]}`);
          else load();
        }}
      />
      <div className="row" style={{ margin: '1rem 0 0.5rem' }}>
        <label className="row small" style={{ gap: 4 }}>
          <input type="checkbox" checked={unlinkedOnly} onChange={(e) => setUnlinkedOnly(e.target.checked)} />
          Only slips not matched to a transaction
        </label>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Shop</th>
                <th className="num">Total</th>
                <th className="num">Lines</th>
                <th>Transaction</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => navigate(`/receipts/${r.id}`)}>
                  <td className="small">{shortDate(r.receipt_date ?? r.created_at)}</td>
                  <td>
                    {r.merchant_name ?? <span className="muted">Unknown shop</span>}
                    {STATUS[r.status] && (
                      <div className="small" style={{ color: r.status === 'failed' ? 'var(--critical-text)' : 'var(--muted)' }}>
                        {STATUS[r.status]}
                      </div>
                    )}
                  </td>
                  <td className="num">{money(r.total)}</td>
                  <td className="num">{r.item_count}</td>
                  <td className="small">
                    {r.transaction_id ? (
                      <span style={{ color: 'var(--good-text)' }}>
                        ✓ {shortDate(r.transaction_date)} {money(r.transaction_amount)}
                      </span>
                    ) : (
                      <span style={{ color: 'var(--warning-text)' }}>Not matched</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {list.length === 0 && <div className="empty">No slips yet — photograph one above.</div>}
      </div>
    </>
  );
}
