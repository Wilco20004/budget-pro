import { useEffect, useState } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { api, DATA_CHANGED, getStoredToken, onAuthRequired, setStoredToken } from './api/client';
import { PeriodProvider } from './components/PeriodContext';
import { setCurrency } from './format';
import Budget from './pages/Budget';
import Savings from './pages/Savings';
import Debt from './pages/Debt';
import Accounts from './pages/Accounts';
import Settle from './pages/Settle';
import Dashboard from './pages/Dashboard';
import Import from './pages/Import';
import Products from './pages/Products';
import ReceiptDetail from './pages/ReceiptDetail';
import Receipts from './pages/Receipts';
import SettingsPage from './pages/SettingsPage';
import Setup from './pages/Setup';
import Transactions from './pages/Transactions';

/** Shown when the UI is opened on the add-on's own port (not through HA
 *  Ingress) and the server wants the API token. */
function TokenPrompt({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState(getStoredToken() ?? '');
  return (
    <div className="card" style={{ maxWidth: 520, margin: '3rem auto' }}>
      <h2>API token needed</h2>
      <p className="small">
        You’re opening BudgetPro directly rather than through the Home Assistant sidebar. Paste the API token from{' '}
        <strong>Settings → API &amp; AI access</strong> (open BudgetPro from the HA sidebar to see it).
      </p>
      <div className="row">
        <input value={token} onChange={(e) => setToken(e.target.value)} style={{ flex: 1 }} placeholder="Token" />
        <button
          className="primary"
          onClick={() => {
            setStoredToken(token.trim());
            onDone();
          }}
        >
          Continue
        </button>
      </div>
    </div>
  );
}

function ReconcileBadge() {
  const [n, setN] = useState(0);
  const loc = useLocation();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    window.addEventListener(DATA_CHANGED, bump);
    return () => window.removeEventListener(DATA_CHANGED, bump);
  }, []);
  useEffect(() => {
    const t = setTimeout(
      () =>
        api
          .kpis()
          .then((k) => setN(k.recon.uncategorized + k.recon.needs_slip))
          .catch(() => undefined),
      300
    );
    return () => clearTimeout(t);
  }, [loc.pathname, loc.search, tick]);
  return n > 0 ? <span className="badge-count">{n}</span> : null;
}

export default function App() {
  const [needToken, setNeedToken] = useState(false);
  const [ready, setReady] = useState(0);

  useEffect(() => onAuthRequired(() => setNeedToken(true)), []);
  useEffect(() => {
    api
      .settings()
      .then((s) => setCurrency(s.currency_symbol))
      .catch(() => undefined);
  }, [ready]);

  if (needToken) {
    return (
      <div className="app">
        <TokenPrompt
          onDone={() => {
            setNeedToken(false);
            setReady((r) => r + 1);
          }}
        />
      </div>
    );
  }

  return (
    <PeriodProvider key={ready}>
      <div className="app">
        <header className="topbar">
          <NavLink to="/" className="brand">
            💸 BudgetPro
          </NavLink>
          <nav>
            <NavLink to="/" end>
              Dashboard
            </NavLink>
            <NavLink to="/transactions">
              Transactions
              <ReconcileBadge />
            </NavLink>
            <NavLink to="/receipts">Slips</NavLink>
            <NavLink to="/budget">Plan</NavLink>
            <NavLink to="/savings">Savings</NavLink>
            <NavLink to="/debt">Debt</NavLink>
            <NavLink to="/accounts">Accounts</NavLink>
            <NavLink to="/settle">Settle up</NavLink>
            <NavLink to="/import">Import</NavLink>
            <NavLink to="/setup">Setup</NavLink>
            <NavLink to="/settings">Settings</NavLink>
          </nav>
        </header>
        <main className="content">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/transactions" element={<Transactions />} />
            <Route path="/receipts" element={<Receipts />} />
            <Route path="/receipts/:id" element={<ReceiptDetail />} />
            <Route path="/products" element={<Products />} />
            <Route path="/budget" element={<Budget />} />
            <Route path="/savings" element={<Savings />} />
            <Route path="/debt" element={<Debt />} />
            <Route path="/accounts" element={<Accounts />} />
            <Route path="/settle" element={<Settle />} />
            <Route path="/import" element={<Import />} />
            <Route path="/setup" element={<Setup />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </main>
      </div>
    </PeriodProvider>
  );
}
