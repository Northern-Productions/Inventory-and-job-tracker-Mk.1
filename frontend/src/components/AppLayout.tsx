import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useIsPhoneLayout } from '../hooks/useIsPhoneLayout';
import { GoogleAccountControl } from '../features/auth/GoogleAccountControl';
import { MobileBottomNav, type MobileNavItem } from './MobileBottomNav';
import { MobileMoreSheet } from './MobileMoreSheet';

const navItems = [
  { to: '/', desktopLabel: 'Inventory', mobileLabel: 'Stock', mobilePlacement: 'primary' as const },
  {
    to: '/allocations',
    desktopLabel: 'Allocations',
    mobileLabel: 'Jobs',
    mobilePlacement: 'primary' as const
  },
  { to: '/inventory/add', desktopLabel: 'Add Box', mobileLabel: 'Add', mobilePlacement: 'primary' as const },
  { to: '/inventory/scan', desktopLabel: 'Scan', mobileLabel: 'Scan', mobilePlacement: 'primary' as const },
  {
    to: '/film-orders',
    desktopLabel: 'Film Orders',
    mobileLabel: 'Film Orders',
    mobilePlacement: 'more' as const
  },
  { to: '/reports', desktopLabel: 'Reports', mobileLabel: 'Reports', mobilePlacement: 'more' as const },
  {
    to: '/checkout-history',
    desktopLabel: 'Checkout History',
    mobileLabel: 'Checkout History',
    mobilePlacement: 'more' as const
  },
  { to: '/activity', desktopLabel: 'Activity', mobileLabel: 'Activity', mobilePlacement: 'more' as const }
];

function isNavItemActive(pathname: string, to: string) {
  if (to === '/') {
    if (pathname === '/') {
      return true;
    }

    if (!pathname.startsWith('/inventory/')) {
      return false;
    }

    return pathname !== '/inventory/add' && pathname !== '/inventory/scan';
  }

  if (to === '/allocations') {
    return pathname === '/allocations' || pathname.startsWith('/allocations/');
  }

  return pathname === to;
}

export function AppLayout() {
  const location = useLocation();
  const isPhoneLayout = useIsPhoneLayout();
  const [isMoreOpen, setIsMoreOpen] = useState(false);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const closeMoreSheet = useCallback(() => setIsMoreOpen(false), []);
  const toggleMoreSheet = useCallback(() => setIsMoreOpen((current) => !current), []);

  const primaryMobileItems = useMemo<MobileNavItem[]>(
    () =>
      navItems
        .filter((item) => item.mobilePlacement === 'primary')
        .map((item) => ({
          label: item.mobileLabel,
          to: item.to,
          active: isNavItemActive(location.pathname, item.to)
        })),
    [location.pathname]
  );
  const moreMobileItems = useMemo<MobileNavItem[]>(
    () =>
      navItems
        .filter((item) => item.mobilePlacement === 'more')
        .map((item) => ({
          label: item.mobileLabel,
          to: item.to,
          active: isNavItemActive(location.pathname, item.to)
        })),
    [location.pathname]
  );
  const isMoreActive = moreMobileItems.some((item) => item.active);

  useEffect(() => {
    closeMoreSheet();
  }, [closeMoreSheet, location.pathname]);

  return (
    <div className={`app-shell ${isPhoneLayout ? 'app-shell-phone' : ''}`.trim()}>
      <header className="app-header">
        <div>
          <p className="eyebrow">Phase 1</p>
          <h1>Window Film Inventory</h1>
        </div>
        <div className="header-actions">
          <GoogleAccountControl />
          {!isPhoneLayout ? (
            <nav className="app-nav" aria-label="Primary">
              {navItems.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === '/'}
                  className={({ isActive }) => `nav-link ${isActive ? 'nav-link-active' : ''}`.trim()}
                >
                  {item.desktopLabel}
                </NavLink>
              ))}
            </nav>
          ) : null}
        </div>
      </header>
      <main className={`app-main ${isPhoneLayout ? 'app-main-phone' : ''}`.trim()}>
        <Outlet />
      </main>
      {isPhoneLayout ? (
        <>
          <MobileBottomNav
            items={primaryMobileItems}
            moreActive={isMoreActive}
            isMoreOpen={isMoreOpen}
            onOpenMore={toggleMoreSheet}
            moreButtonRef={moreButtonRef}
          />
          <MobileMoreSheet
            open={isMoreOpen}
            items={moreMobileItems}
            activePath={location.pathname}
            onClose={closeMoreSheet}
            anchorRef={moreButtonRef}
          />
        </>
      ) : null}
    </div>
  );
}
