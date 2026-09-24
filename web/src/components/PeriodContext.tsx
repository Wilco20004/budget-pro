import { createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { api } from '../api/client';
import { Period } from '../types';

interface PeriodState {
  periods: Period[];
  current: Period | null;
  selected: Period | null;
  select: (start: string) => void;
  reload: () => void;
}

const Ctx = createContext<PeriodState>({ periods: [], current: null, selected: null, select: () => undefined, reload: () => undefined });

const KEY = 'budgetpro.period';

export function PeriodProvider({ children }: { children: ReactNode }) {
  const [periods, setPeriods] = useState<Period[]>([]);
  const [current, setCurrent] = useState<Period | null>(null);
  const [selectedStart, setSelectedStart] = useState<string | null>(() => {
    try {
      return sessionStorage.getItem(KEY);
    } catch {
      return null;
    }
  });

  const reload = useCallback(() => {
    api
      .periods(24)
      .then((r) => {
        setPeriods(r.periods);
        setCurrent(r.current);
      })
      .catch(() => undefined);
  }, []);

  useEffect(reload, [reload]);

  const select = (start: string) => {
    setSelectedStart(start);
    try {
      sessionStorage.setItem(KEY, start);
    } catch {
      // ignore
    }
  };

  const selected = periods.find((p) => p.start === selectedStart) ?? current;
  return <Ctx.Provider value={{ periods, current, selected, select, reload }}>{children}</Ctx.Provider>;
}

export function usePeriod() {
  return useContext(Ctx);
}

export function PeriodPicker() {
  const { periods, current, selected, select } = usePeriod();
  if (!selected) return null;
  const idx = periods.findIndex((p) => p.start === selected.start);
  // periods are newest first
  const older = idx >= 0 && idx < periods.length - 1 ? periods[idx + 1] : null;
  const newer = idx > 0 ? periods[idx - 1] : null;
  return (
    <div className="period-picker">
      <button onClick={() => older && select(older.start)} disabled={!older} aria-label="Previous period">
        ‹
      </button>
      <select value={selected.start} onChange={(e) => select(e.target.value)} aria-label="Budget period">
        {periods.map((p) => (
          <option key={p.start} value={p.start}>
            {p.label}
            {current && p.start === current.start ? ' (current)' : ''}
          </option>
        ))}
      </select>
      <button onClick={() => newer && select(newer.start)} disabled={!newer} aria-label="Next period">
        ›
      </button>
    </div>
  );
}
