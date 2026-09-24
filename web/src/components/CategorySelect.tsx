import { Category } from '../types';

const KIND_LABEL: Record<string, string> = {
  expense: 'Expenses',
  income: 'Income',
  savings: 'Savings',
  transfer: 'Transfers (not counted)',
  loan: 'Borrowed (not income)',
};

/** Categories in picker order: each subcategory right under its parent. */
export function withChildren(categories: Category[]): Category[] {
  const ids = new Set(categories.map((c) => c.id));
  const top = categories.filter((c) => !c.parent_id || !ids.has(c.parent_id));
  return top.flatMap((p) => [p, ...categories.filter((c) => c.parent_id === p.id)]);
}

export default function CategorySelect({
  categories,
  value,
  onChange,
  placeholder = 'Choose category…',
  allowEmpty = true,
  kinds,
}: {
  categories: Category[];
  value: string | null;
  onChange: (id: string | null) => void;
  placeholder?: string;
  allowEmpty?: boolean;
  kinds?: string[];
}) {
  const groups = ['expense', 'income', 'savings', 'transfer', 'loan'].filter((k) => !kinds || kinds.includes(k));
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      {allowEmpty && <option value="">{placeholder}</option>}
      {groups.map((k) => {
        const cats = withChildren(categories.filter((c) => c.kind === k && (!c.archived || c.id === value)));
        if (!cats.length) return null;
        return (
          <optgroup key={k} label={KIND_LABEL[k]}>
            {cats.map((c) => (
              <option key={c.id} value={c.id}>
                {/* Non-breaking spaces: a select collapses ordinary ones. */}
                {c.parent_id && cats.some((p) => p.id === c.parent_id) ? '   ↳ ' : ''}
                {c.icon ? `${c.icon} ` : ''}
                {c.name}
                {c.requires_slip ? ' 🧾' : ''}
              </option>
            ))}
          </optgroup>
        );
      })}
    </select>
  );
}
