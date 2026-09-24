import { Category } from '../types';

const KIND_LABEL: Record<string, string> = {
  expense: 'Expenses',
  income: 'Income',
  savings: 'Savings',
  transfer: 'Transfers (not counted)',
};

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
  const groups = ['expense', 'income', 'savings', 'transfer'].filter((k) => !kinds || kinds.includes(k));
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      {allowEmpty && <option value="">{placeholder}</option>}
      {groups.map((k) => {
        const cats = categories.filter((c) => c.kind === k && (!c.archived || c.id === value));
        if (!cats.length) return null;
        return (
          <optgroup key={k} label={KIND_LABEL[k]}>
            {cats.map((c) => (
              <option key={c.id} value={c.id}>
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
