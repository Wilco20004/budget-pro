import { useState } from 'react';
import { Category, Transaction } from '../types';
import { money, tempKey } from '../format';
import CategorySelect from './CategorySelect';

interface Row {
  key: string;
  category_id: string | null;
  amount: string;
  note: string;
}

/** Divide one transaction over several categories. Amounts are positive
 *  here; the server applies the transaction's sign. */
export default function SplitEditor({
  tx,
  categories,
  onSave,
}: {
  tx: Transaction;
  categories: Category[];
  onSave: (splits: { category_id: string; amount: number; note: string | null }[]) => Promise<void>;
}) {
  const total = Math.abs(tx.amount);
  const [rows, setRows] = useState<Row[]>(() =>
    tx.splits.length
      ? tx.splits.map((s) => ({ key: tempKey(), category_id: s.category_id, amount: Math.abs(s.amount).toFixed(2), note: s.note ?? '' }))
      : [{ key: tempKey(), category_id: null, amount: total.toFixed(2), note: '' }]
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sum = rows.reduce((a, r) => a + (parseFloat(r.amount) || 0), 0);
  const left = Math.round((total - sum) * 100) / 100;

  const update = (key: string, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await onSave(
        rows
          .filter((r) => r.category_id && parseFloat(r.amount))
          .map((r) => ({ category_id: r.category_id!, amount: parseFloat(r.amount), note: r.note || null }))
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="split-editor">
      {rows.map((r) => (
        <div className="split-row" key={r.key}>
          <CategorySelect categories={categories} value={r.category_id} onChange={(id) => update(r.key, { category_id: id })} />
          <input
            type="number"
            step="0.01"
            inputMode="decimal"
            value={r.amount}
            onChange={(e) => update(r.key, { amount: e.target.value })}
            style={{ width: '7.5rem' }}
            aria-label="Amount"
          />
          <input placeholder="Note" value={r.note} onChange={(e) => update(r.key, { note: e.target.value })} style={{ width: '10rem' }} />
          {rows.length > 1 && (
            <button className="link danger" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} aria-label="Remove split">
              ✕
            </button>
          )}
        </div>
      ))}
      <div className="row small">
        <button
          onClick={() =>
            setRows((rs) => [...rs, { key: tempKey(), category_id: null, amount: left > 0 ? left.toFixed(2) : '', note: '' }])
          }
        >
          + Add split
        </button>
        <span className={Math.abs(left) < 0.01 ? 'muted' : ''} style={{ color: Math.abs(left) < 0.01 ? undefined : 'var(--critical-text)' }}>
          {Math.abs(left) < 0.01 ? `Adds up to ${money(total)}` : `${money(left)} ${left > 0 ? 'still to assign' : 'too much'}`}
        </span>
        <span className="spacer" />
        <button className="primary" onClick={save} disabled={saving || Math.abs(left) >= 0.01}>
          {saving ? 'Saving…' : 'Save splits'}
        </button>
      </div>
      {error && <div className="error small">{error}</div>}
    </div>
  );
}
