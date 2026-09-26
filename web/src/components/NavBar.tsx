import { ReactNode, useEffect, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';

interface Item {
  to: string;
  label: string;
  end?: boolean;
  badge?: boolean;
}

// The pages, grouped. The first group is always on show on a wide screen;
// the others are dropdowns there and sections in the phone menu.
const GROUPS: { name: string; items: Item[] }[] = [
  {
    name: 'Everyday',
    items: [
      { to: '/', label: 'Dashboard', end: true },
      { to: '/transactions', label: 'Transactions', badge: true },
      { to: '/receipts', label: 'Slips' },
      { to: '/budget', label: 'Plan' },
    ],
  },
  {
    name: 'Money',
    items: [
      { to: '/savings', label: 'Savings' },
      { to: '/debt', label: 'Debt' },
      { to: '/accounts', label: 'Accounts' },
      { to: '/settle', label: 'Settle up' },
    ],
  },
  {
    name: 'Manage',
    items: [
      { to: '/import', label: 'Import' },
      { to: '/setup', label: 'Setup' },
      { to: '/settings', label: 'Settings' },
    ],
  },
];

const ALL = GROUPS.flatMap((g) => g.items);

function isActive(item: Item, path: string) {
  if (item.end) return path === item.to;
  return path === item.to || path.startsWith(`${item.to}/`) || (item.to === '/receipts' && path.startsWith('/products'));
}

/** Inside Home Assistant (Ingress iframe) HA shows its own title bar. */
function embedded(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

function Dropdown({ name, items, path, badge }: { name: string; items: Item[]; path: string; badge: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  const current = items.find((i) => isActive(i, path));
  return (
    <div className="nav-drop" ref={ref}>
      <button className={`nav-drop-btn${current ? ' active' : ''}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        {current ? current.label : name} <span aria-hidden>▾</span>
      </button>
      {open && (
        <div className="nav-drop-menu" role="menu">
          {items.map((i) => (
            <NavLink key={i.to} to={i.to} end={i.end} role="menuitem">
              {i.label}
              {i.badge && badge}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}

export default function NavBar({ badge }: { badge: ReactNode }) {
  const { pathname } = useLocation();
  const [drawer, setDrawer] = useState(false);
  const inHa = embedded();
  useEffect(() => setDrawer(false), [pathname]);
  useEffect(() => {
    if (!drawer) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setDrawer(false);
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [drawer]);
  const current = ALL.find((i) => isActive(i, pathname));

  return (
    <header className={`topbar${inHa ? ' embedded' : ''}`}>
      {!inHa && (
        <NavLink to="/" className="brand">
          💸 BudgetPro
        </NavLink>
      )}

      {/* Wide screens: everyday pages, then a dropdown per group. */}
      <nav className="nav-wide">
        {GROUPS[0].items.map((i) => (
          <NavLink key={i.to} to={i.to} end={i.end}>
            {i.label}
            {i.badge && badge}
          </NavLink>
        ))}
        {GROUPS.slice(1).map((g) => (
          <Dropdown key={g.name} name={g.name} items={g.items} path={pathname} badge={badge} />
        ))}
      </nav>

      {/* Phones: where you are, and a menu that slides in from the right. */}
      <div className="nav-narrow">
        <span className="nav-current">
          {current?.label ?? 'BudgetPro'}
          {current?.badge && badge}
        </span>
        {badge && current?.to !== '/transactions' && (
          <NavLink to="/transactions" className="nav-todo" aria-label="Transactions to sort">
            {badge}
          </NavLink>
        )}
        <button className="nav-burger" aria-label="Menu" aria-expanded={drawer} onClick={() => setDrawer(true)}>
          ☰
        </button>
      </div>

      {drawer && (
        <div className="drawer-backdrop" onClick={() => setDrawer(false)}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()} aria-label="Menu">
            <div className="drawer-head">
              <strong>💸 BudgetPro</strong>
              <button className="nav-burger" aria-label="Close menu" onClick={() => setDrawer(false)}>
                ×
              </button>
            </div>
            {GROUPS.map((g) => (
              <div key={g.name} className="drawer-group">
                <div className="drawer-group-name">{g.name}</div>
                {g.items.map((i) => (
                  <NavLink key={i.to} to={i.to} end={i.end}>
                    {i.label}
                    {i.badge && badge}
                  </NavLink>
                ))}
              </div>
            ))}
          </aside>
        </div>
      )}
    </header>
  );
}
