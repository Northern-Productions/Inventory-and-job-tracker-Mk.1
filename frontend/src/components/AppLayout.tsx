import { NavLink, Outlet } from 'react-router-dom';
import { GoogleAccountControl } from '../features/auth/GoogleAccountControl';

const navItems = [
  { to: '/', label: 'Inventory' },
  { to: '/allocations', label: 'Allocations' },
  { to: '/inventory/add', label: 'Add Box' },
  { to: '/film-orders', label: 'Film Orders' },
  { to: '/inventory/scan', label: 'Scan' },
  { to: '/reports', label: 'Reports' },
  { to: '/checkout-history', label: 'Checkout History' },
  { to: '/activity', label: 'Activity' }
];

export function AppLayout() {
  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">Phase 1</p>
          <h1>Window Film Inventory</h1>
        </div>
        <div className="header-actions">
          <GoogleAccountControl />
          <nav className="app-nav" aria-label="Primary">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) => `nav-link ${isActive ? 'nav-link-active' : ''}`.trim()}
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>
      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
