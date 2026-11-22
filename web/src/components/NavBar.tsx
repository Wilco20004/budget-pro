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

// Phones: a tab bar along the bottom for the everyday pages; More opens the menu.
const TABS: { to: string; label: string; end?: boolean; badge?: boolean; icon: ReactNode }[] = [
  {
    to: '/',
    label: 'Home',
    end: true,
    icon: <path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" />,
  },
  {
    to: '/transactions',
    label: 'Transactions',
    badge: true,
    icon: <path d="M7 4v14m0 0-3-3m3 3 3-3M17 20V6m0 0-3 3m3-3 3 3" />,
  },
  {
    to: '/receipts',
    label: 'Slips',
    icon: <path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3" />,
  },
  {
    to: '/budget',
    label: 'Plan',
    icon: <path d="M4 20V10m6 10V4m6 16v-7m4 7H2" />,
  },
];

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
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
  const onTab = TABS.some((t) => isActive(t, pathname));
  // The on-screen keyboard pushes a fixed bar up over the form: hide it while typing.
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    const field = (t: Element | null) => {
      if (!(t instanceof HTMLElement)) return false;
      return !!t && (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || (t.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'file'].includes((t as HTMLInputElement).type)));
    };
    // A field removed while focused sends no focusout: decide from what has focus
    // now, and look again shortly after (focus has moved on by then).
    const check = () => setTyping(field(document.activeElement));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const on = () => {
      check();
      clearTimeout(timer);
      timer = setTimeout(check, 400);
    };
    document.addEventListener('focusin', on);
    document.addEventListener('focusout', on);
    const poll = setInterval(check, 1000);
    return () => {
      document.removeEventListener('focusin', on);
      document.removeEventListener('focusout', on);
      clearTimeout(timer);
      clearInterval(poll);
    };
  }, []);
  useEffect(() => setTyping(false), [pathname]);

  return (
    <>
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

      {/* Phones: where you are; the tab bar at the bottom does the moving around. */}
      <div className="nav-narrow">
        <span className="nav-current">{current?.label ?? 'BudgetPro'}</span>
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

    <nav className={`tabbar${typing ? ' typing' : ''}`} aria-label="Main">
      {TABS.map((t) => (
        <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive: a }) => (a || isActive(t, pathname) ? 'active' : '')}>
          <span className="tab-icon">
            <Icon>{t.icon}</Icon>
            {t.badge && badge}
          </span>
          <span className="tab-label">{t.label}</span>
        </NavLink>
      ))}
      <button className={!onTab ? 'active' : ''} aria-label="More pages" aria-expanded={drawer} onClick={() => setDrawer(true)}>
        <span className="tab-icon">
          <Icon>
            <path d="M4 6h16M4 12h16M4 18h16" />
          </Icon>
        </span>
        <span className="tab-label">{!onTab && current ? current.label : 'More'}</span>
      </button>
    </nav>
    </>
  );
}
