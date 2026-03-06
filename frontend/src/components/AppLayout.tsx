import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useIsPhoneLayout } from '../hooks/useIsPhoneLayout';
import { AccountControl } from '../features/auth/AccountControl';
import { MobileBottomNav, type MobileNavItem } from './MobileBottomNav';
import { MobileMoreSheet } from './MobileMoreSheet';

type NavPlacement = 'primary' | 'more';

interface NavItem {
  to: string;
  desktopLabel: string;
  mobileLabel: string;
  desktopPlacement: NavPlacement;
  mobilePlacement: NavPlacement;
}

const navItems: NavItem[] = [
  {
    to: '/',
    desktopLabel: 'Inventory',
    mobileLabel: 'Stock',
    desktopPlacement: 'primary',
    mobilePlacement: 'primary'
  },
  {
    to: '/allocations',
    desktopLabel: 'Jobs',
    mobileLabel: 'Jobs',
    desktopPlacement: 'primary',
    mobilePlacement: 'primary'
  },
  {
    to: '/inventory/add',
    desktopLabel: 'Add Box',
    mobileLabel: 'Add',
    desktopPlacement: 'primary',
    mobilePlacement: 'primary'
  },
  {
    to: '/inventory/scan',
    desktopLabel: 'Scan',
    mobileLabel: 'Scan',
    desktopPlacement: 'primary',
    mobilePlacement: 'primary'
  },
  {
    to: '/film-orders',
    desktopLabel: 'Film Orders',
    mobileLabel: 'Film Orders',
    desktopPlacement: 'primary',
    mobilePlacement: 'more'
  },
  {
    to: '/reports',
    desktopLabel: 'Reports',
    mobileLabel: 'Reports',
    desktopPlacement: 'more',
    mobilePlacement: 'more'
  },
  {
    to: '/checkout-history',
    desktopLabel: 'Checkout History',
    mobileLabel: 'Checkout History',
    desktopPlacement: 'more',
    mobilePlacement: 'more'
  },
  {
    to: '/activity',
    desktopLabel: 'Activity',
    mobileLabel: 'Activity',
    desktopPlacement: 'more',
    mobilePlacement: 'more'
  }
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
  const [isMobileMoreOpen, setIsMobileMoreOpen] = useState(false);
  const [isDesktopMoreOpen, setIsDesktopMoreOpen] = useState(false);
  const mobileMoreButtonRef = useRef<HTMLButtonElement>(null);
  const desktopMoreRef = useRef<HTMLDivElement>(null);
  const closeMobileMoreSheet = useCallback(() => setIsMobileMoreOpen(false), []);
  const toggleMobileMoreSheet = useCallback(() => setIsMobileMoreOpen((current) => !current), []);
  const toggleDesktopMoreMenu = useCallback(
    () => setIsDesktopMoreOpen((current) => !current),
    []
  );
  const closeDesktopMoreMenu = useCallback(() => setIsDesktopMoreOpen(false), []);

  const primaryNavItems = useMemo(
    () =>
      navItems
        .filter((item) => item.desktopPlacement === 'primary')
        .map((item) => ({ ...item, active: isNavItemActive(location.pathname, item.to) })),
    [location.pathname]
  );
  const moreDesktopNavItems = useMemo(
    () =>
      navItems
        .filter((item) => item.desktopPlacement === 'more')
        .map((item) => ({ ...item, active: isNavItemActive(location.pathname, item.to) })),
    [location.pathname]
  );
  const primaryMobileNavItems = useMemo(
    () =>
      navItems
        .filter((item) => item.mobilePlacement === 'primary')
        .map((item) => ({ ...item, active: isNavItemActive(location.pathname, item.to) })),
    [location.pathname]
  );
  const moreMobileNavItems = useMemo(
    () =>
      navItems
        .filter((item) => item.mobilePlacement === 'more')
        .map((item) => ({ ...item, active: isNavItemActive(location.pathname, item.to) })),
    [location.pathname]
  );
  const primaryMobileItems = useMemo<MobileNavItem[]>(
    () =>
      primaryMobileNavItems.map((item) => ({
        label: item.mobileLabel,
        to: item.to,
        active: item.active
      })),
    [primaryMobileNavItems]
  );
  const moreMobileItems = useMemo<MobileNavItem[]>(
    () => moreMobileNavItems.map((item) => ({ label: item.mobileLabel, to: item.to, active: item.active })),
    [moreMobileNavItems]
  );
  const isDesktopMoreActive = moreDesktopNavItems.some((item) => item.active);
  const isMobileMoreActive = moreMobileNavItems.some((item) => item.active);

  useEffect(() => {
    closeMobileMoreSheet();
    closeDesktopMoreMenu();
  }, [closeDesktopMoreMenu, closeMobileMoreSheet, location.pathname]);

  useEffect(() => {
    if (isPhoneLayout || !isDesktopMoreOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (desktopMoreRef.current?.contains(event.target as Node)) {
        return;
      }

      closeDesktopMoreMenu();
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeDesktopMoreMenu();
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [closeDesktopMoreMenu, isDesktopMoreOpen, isPhoneLayout]);

  return (
    <div className={`app-shell ${isPhoneLayout ? 'app-shell-phone' : ''}`.trim()}>
      <header className="app-header">
        <div>
          <p className="eyebrow">Phase 1</p>
          <h1>Window Film Inventory</h1>
        </div>
        <div className="header-actions">
          <AccountControl />
          {!isPhoneLayout ? (
            <nav className="app-nav" aria-label="Primary">
              {primaryNavItems.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === '/'}
                  className={({ isActive }) => `nav-link ${isActive ? 'nav-link-active' : ''}`.trim()}
                >
                  {item.desktopLabel}
                </NavLink>
              ))}
              <div className="app-nav-more-wrap" ref={desktopMoreRef}>
                <button
                  type="button"
                  className={`nav-link nav-more-button ${
                    isDesktopMoreActive || isDesktopMoreOpen ? 'nav-link-active' : ''
                  }`.trim()}
                  onClick={toggleDesktopMoreMenu}
                  aria-haspopup="menu"
                  aria-expanded={isDesktopMoreOpen}
                >
                  More
                </button>
                {isDesktopMoreOpen ? (
                  <div className="nav-more-menu" role="menu" aria-label="More pages">
                    {moreDesktopNavItems.map((item) => (
                      <NavLink
                        key={item.to}
                        to={item.to}
                        className={`nav-more-item ${item.active ? 'nav-more-item-active' : ''}`.trim()}
                        role="menuitem"
                        onClick={closeDesktopMoreMenu}
                      >
                        {item.desktopLabel}
                      </NavLink>
                    ))}
                  </div>
                ) : null}
              </div>
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
            moreActive={isMobileMoreActive}
            isMoreOpen={isMobileMoreOpen}
            onOpenMore={toggleMobileMoreSheet}
            moreButtonRef={mobileMoreButtonRef}
          />
          <MobileMoreSheet
            open={isMobileMoreOpen}
            items={moreMobileItems}
            activePath={location.pathname}
            onClose={closeMobileMoreSheet}
            anchorRef={mobileMoreButtonRef}
          />
        </>
      ) : null}
    </div>
  );
}
