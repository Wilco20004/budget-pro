import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, fetchReceiptFileUrl } from '../api/client';
import CategorySelect from '../components/CategorySelect';
import { money, shortDate, tempKey } from '../format';
import { Category, ReceiptDetail as Receipt } from '../types';

interface Line {
  key: string;
  raw_name: string;
  quantity: string;
  amount: string;
  category_id: string | null;
  barcode: string | null;
}

const toLines = (r: Receipt): Line[] =>
  r.items.map((i) => ({
    key: i.id,
    raw_name: i.raw_name,
    quantity: String(i.quantity),
    amount: i.amount.toFixed(2),
    category_id: i.category_id,
    barcode: i.barcode,
  }));

export default function ReceiptDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [r, setR] = useState<Receipt | null>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [head, setHead] = useState({ merchant_name: '', receipt_date: '', total: '' });
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const apply = (x: Receipt) => {
    setR(x);
    setLines(toLines(x));
    setHead({ merchant_name: x.merchant_name ?? '', receipt_date: x.receipt_date ?? '', total: x.total !== null ? x.total.toFixed(2) : '' });
    setDirty(false);
  };

  const load = () => id && api.receipt(id).then(apply).catch((e) => setError(e.message));

  useEffect(() => {
    load();
    api.categories().then(setCategories).catch(() => undefined);
  }, [id]);

  useEffect(() => {
    if (!id) return;
    let url: string | null = null;
    fetchReceiptFileUrl(id)
      .then((u) => {
        url = u;
        setFileUrl(u);
      })
      .catch(() => undefined);
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [id]);

  // Poll while OCR is running.
  useEffect(() => {
    if (!r || (r.status !== 'pending' && r.status !== 'processing')) return;
    const t = setInterval(() => id && api.receipt(id).then((x) => (x.status !== r.status ? apply(x) : undefined)), 2000);
    return () => clearInterval(t);
  }, [r?.status]);

  const byCategory = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of lines) {
      const name = categories.find((c) => c.id === l.category_id)?.name ?? 'Uncategorised';
      m.set(name, (m.get(name) ?? 0) + (parseFloat(l.amount) || 0));
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [lines, categories]);
  const linesTotal = lines.reduce((a, l) => a + (parseFloat(l.amount) || 0), 0);

  const update = (key: string, patch: Partial<Line>) => {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
    setDirty(true);
  };

  async function act<T>(p: Promise<T>, msg?: string) {
    setBusy(true);
    setError(null);
    try {
      const x = await p;
      if (x && typeof x === 'object' && 'items' in x) apply(x as unknown as Receipt);
      if (msg) setSaved(msg);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveAll() {
    if (!r) return;
    await act(
      api
        .updateReceipt(r.id, {
          merchant_name: head.merchant_name || null,
          merchant_id: r.merchant_id,
          receipt_date: head.receipt_date || null,
          total: head.total ? parseFloat(head.total) : null,
        })
        .then(() =>
          api.saveReceiptItems(
            r.id,
            lines.map((l) => ({
              raw_name: l.raw_name,
              quantity: parseFloat(l.quantity) || 1,
              amount: parseFloat(l.amount) || 0,
              category_id: l.category_id,
              barcode: l.barcode,
            }))
          )
        ),
      r.transaction_id ? 'Saved — the transaction’s split was updated and products remembered.' : 'Saved — products remembered.'
    );
  }

  if (!r) return error ? <div className="error">{error}</div> : <p className="muted">Loading…</p>;
  const reading = r.status === 'pending' || r.status === 'processing';

  return (
    <>
      <p className="small">
        <Link to="/receipts">← Slips</Link>
      </p>
      <div className="page-head">
        <h1>{r.merchant_name ?? 'Slip'}</h1>
        <div className="row">
          <button onClick={() => act(api.rescanReceipt(r.id), 'Re-read the slip.')} disabled={busy || reading}>
            Re-scan
          </button>
          <button
            className="danger"
            onClick={() => confirm('Delete this slip?') && api.deleteReceipt(r.id).then(() => navigate('/receipts'))}
          >
            Delete
          </button>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      {saved && (
        <div className="notice" onClick={() => setSaved(null)}>
          {saved}
        </div>
      )}
      {reading && <div className="notice">⏳ Reading the slip… this can take up to a minute on the Home Assistant box.</div>}
      {r.status === 'failed' && <div className="error">Couldn’t read this slip: {r.error}. You can still type the lines in below.</div>}

      <div className="receipt-layout">
        <div>
          {fileUrl &&
            (r.mime_type === 'application/pdf' ? (
              <iframe src={fileUrl} title="Slip" className="receipt-image" style={{ height: 520 }} />
            ) : (
              <a href={fileUrl} target="_blank" rel="noreferrer">
                <img src={fileUrl} alt="Slip" className="receipt-image" />
              </a>
            ))}
          {r.ocr_text && (
            <details style={{ marginTop: '0.5rem' }}>
              <summary className="small muted">Raw text ({r.engine})</summary>
              <pre>{r.ocr_text}</pre>
            </details>
          )}
          {r.mime_type === 'none' && (
            <div className="notice small">Logged by Claude over MCP from a photo — no image is stored for this slip.</div>
          )}
          {r.engine && !r.ocr_text && r.mime_type !== 'none' && (
            <p className="small muted">Read by {r.engine === 'claude' ? 'Claude' : r.engine}.</p>
          )}
        </div>

        <div>
          <div className="card">
            <div className="form-grid">
              <label className="field">
                Shop
                <input value={head.merchant_name} onChange={(e) => (setHead({ ...head, merchant_name: e.target.value }), setDirty(true))} />
              </label>
              <label className="field">
                Date
                <input type="date" value={head.receipt_date} onChange={(e) => (setHead({ ...head, receipt_date: e.target.value }), setDirty(true))} />
              </label>
              <label className="field">
                Total paid
                <input
                  type="number"
                  step="0.01"
                  inputMode="decimal"
                  value={head.total}
                  onChange={(e) => (setHead({ ...head, total: e.target.value }), setDirty(true))}
                />
              </label>
            </div>
          </div>

          <div className="card">
            <h2>Transaction</h2>
            {r.transaction ? (
              <div className="row">
                <span style={{ color: 'var(--good-text)' }}>✓</span>
                <span>
                  {shortDate(r.transaction.date)} · {r.transaction.description} · <strong>{money(r.transaction.amount)}</strong>
                </span>
                <span className="spacer" />
                <button onClick={() => act(api.unlinkReceipt(r.id))}>Unlink</button>
              </div>
            ) : r.candidates.length ? (
              <>
                <p className="small muted" style={{ marginTop: 0 }}>
                  Not matched automatically. Pick the bank transaction this slip belongs to — its split will be set from the lines below.
                </p>
                <table>
                  <tbody>
                    {r.candidates.map((c) => (
                      <tr key={c.id}>
                        <td className="small">{shortDate(c.date)}</td>
                        <td className="small">{c.description}</td>
                        <td className="num">{money(c.amount)}</td>
                        <td>
                          <button onClick={() => act(api.linkReceipt(r.id, c.id), 'Linked and split.')}>Link</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : (
              <p className="small muted" style={{ margin: 0 }}>
                No matching transaction yet — it’ll be matched automatically when the statement is imported.
              </p>
            )}
          </div>

          <div className="card">
            <div className="row" style={{ marginBottom: '0.5rem' }}>
              <h2 style={{ margin: 0 }}>Lines</h2>
              <span className="spacer" />
              <span className="small muted">
                {money(linesTotal)}
                {r.total !== null && Math.abs(linesTotal - r.total) >= 0.01 && (
                  <span style={{ color: 'var(--warning-text)' }}> · {money(r.total - linesTotal)} not on a line</span>
                )}
              </span>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Item</th>
                    <th className="num">Qty</th>
                    <th className="num">Amount</th>
                    <th>Category</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.key}>
                      <td>
                        <input value={l.raw_name} onChange={(e) => update(l.key, { raw_name: e.target.value })} style={{ width: '100%', minWidth: 160 }} />
                      </td>
                      <td>
                        <input value={l.quantity} onChange={(e) => update(l.key, { quantity: e.target.value })} style={{ width: '3.5rem' }} inputMode="decimal" />
                      </td>
                      <td>
                        <input value={l.amount} onChange={(e) => update(l.key, { amount: e.target.value })} style={{ width: '6rem' }} inputMode="decimal" />
                      </td>
                      <td>
                        <CategorySelect categories={categories} value={l.category_id} onChange={(id) => update(l.key, { category_id: id })} kinds={['expense', 'savings']} />
                      </td>
                      <td>
                        <button
                          className="link danger"
                          onClick={() => {
                            setLines((ls) => ls.filter((x) => x.key !== l.key));
                            setDirty(true);
                          }}
                          aria-label="Remove line"
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="row" style={{ marginTop: '0.5rem' }}>
              <button
                onClick={() => {
                  setLines((ls) => [...ls, { key: tempKey(), raw_name: '', quantity: '1', amount: '', category_id: null, barcode: null }]);
                  setDirty(true);
                }}
              >
                + Add line
              </button>
              <span className="spacer" />
              <button className="primary" onClick={saveAll} disabled={busy || !dirty}>
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
            {byCategory.length > 0 && (
              <div style={{ marginTop: '1rem' }}>
                <div className="small muted">By category</div>
                {byCategory.map(([name, amt]) => (
                  <div className="row small" key={name}>
                    <span>{name}</span>
                    <span className="spacer" />
                    <span className="num">{money(amt)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
