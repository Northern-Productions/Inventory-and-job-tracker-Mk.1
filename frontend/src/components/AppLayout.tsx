import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import type { FeatureAccessMode, FeatureArea } from '../domain';
import { useIsPhoneLayout } from '../hooks/useIsPhoneLayout';
import { AccountControl } from '../features/auth/AccountControl';
import { useAuth } from '../features/auth/AuthContext';
import { MobileBottomNav, type MobileNavItem } from './MobileBottomNav';
import { MobileMoreSheet } from './MobileMoreSheet';

type NavPlacement = 'primary' | 'more';
type AppShellTheme = 'inventory' | 'jobs' | 'add-box' | 'scan' | 'film-orders' | 'more';

interface NavItem {
  to: string;
  desktopLabel: string;
  mobileLabel: string;
  desktopPlacement: NavPlacement;
  mobilePlacement: NavPlacement;
  feature?: FeatureArea;
  mode?: FeatureAccessMode;
  adminConsoleOnly?: boolean;
  ownerOnly?: boolean;
}

interface ComputedNavItem extends NavItem {
  active: boolean;
  showAttentionDot: boolean;
}

const navItems: NavItem[] = [
  {
    to: '/',
    desktopLabel: 'Inventory',
    mobileLabel: 'Stock',
    desktopPlacement: 'primary',
    mobilePlacement: 'primary',
    feature: 'inventory',
    mode: 'read'
  },
  {
    to: '/allocations',
    desktopLabel: 'Jobs',
    mobileLabel: 'Jobs',
    desktopPlacement: 'primary',
    mobilePlacement: 'primary',
    feature: 'allocations',
    mode: 'read'
  },
  {
    to: '/inventory/add',
    desktopLabel: 'Add Box',
    mobileLabel: 'Add',
    desktopPlacement: 'primary',
    mobilePlacement: 'primary',
    feature: 'inventory',
    mode: 'write'
  },
  {
    to: '/inventory/scan',
    desktopLabel: 'Scan',
    mobileLabel: 'Scan',
    desktopPlacement: 'primary',
    mobilePlacement: 'primary',
    feature: 'inventory',
    mode: 'write'
  },
  {
    to: '/film-orders',
    desktopLabel: 'Film Orders',
    mobileLabel: 'Film Orders',
    desktopPlacement: 'primary',
    mobilePlacement: 'more',
    feature: 'film_orders',
    mode: 'read'
  },
  {
    to: '/reports',
    desktopLabel: 'Reports',
    mobileLabel: 'Reports',
    desktopPlacement: 'more',
    mobilePlacement: 'more',
    feature: 'reports',
    mode: 'read'
  },
  {
    to: '/checkout-history',
    desktopLabel: 'Checkout History',
    mobileLabel: 'Checkout History',
    desktopPlacement: 'more',
    mobilePlacement: 'more',
    feature: 'activity_history',
    mode: 'read'
  },
  {
    to: '/activity',
    desktopLabel: 'Activity',
    mobileLabel: 'Activity',
    desktopPlacement: 'more',
    mobilePlacement: 'more',
    feature: 'activity_history',
    mode: 'read'
  },
  {
    to: '/admin/access',
    desktopLabel: 'Access',
    mobileLabel: 'Access',
    desktopPlacement: 'more',
    mobilePlacement: 'more',
    feature: 'access_management',
    mode: 'read',
    adminConsoleOnly: true
  },
  {
    to: '/owner/admin-permissions',
    desktopLabel: 'Admin Access',
    mobileLabel: 'Admin Access',
    desktopPlacement: 'more',
    mobilePlacement: 'more',
    ownerOnly: true
  },
  {
    to: '/owner/notification-preferences',
    desktopLabel: 'Owner Alerts',
    mobileLabel: 'Owner Alerts',
    desktopPlacement: 'more',
    mobilePlacement: 'more',
    ownerOnly: true
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

function resolveAppShellTheme(pathname: string): AppShellTheme {
  const normalizedPath = pathname || '/';

  if (normalizedPath === '/inventory/add') {
    return 'add-box';
  }

  if (normalizedPath === '/inventory/scan') {
    return 'scan';
  }

  if (normalizedPath === '/film-orders') {
    return 'film-orders';
  }

  if (normalizedPath === '/caulk') {
    return 'inventory';
  }

  if (normalizedPath === '/' || normalizedPath.startsWith('/inventory/')) {
    return 'inventory';
  }

  if (normalizedPath === '/allocations' || normalizedPath.startsWith('/allocations/')) {
    return 'jobs';
  }

  if (
    normalizedPath.startsWith('/reports') ||
    normalizedPath.startsWith('/activity') ||
    normalizedPath.startsWith('/checkout-history') ||
    normalizedPath.startsWith('/admin/') ||
    normalizedPath.startsWith('/owner/')
  ) {
    return 'more';
  }

  return 'more';
}

export function AppLayout() {
  const auth = useAuth();
  const location = useLocation();
  const isPhoneLayout = useIsPhoneLayout();
  const appShellTheme = useMemo(
    () => resolveAppShellTheme(location.pathname),
    [location.pathname]
  );
  const hasMountedRef = useRef(false);
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

  const visibleNavItems = useMemo(() => {
    return navItems.filter((item) => {
      if (item.ownerOnly && !auth.isOwner) {
        return false;
      }

      if (item.adminConsoleOnly && !auth.canAccessAdminConsole) {
        return false;
      }

      if (item.feature && !auth.hasFeatureAccess(item.feature, item.mode || 'read')) {
        return false;
      }

      return true;
    });
  }, [auth]);
  const hasPendingAccessApprovals =
    auth.isOwner && Number(auth.accessContext?.pendingCount || 0) > 0;
  const showAccessPendingAttention =
    hasPendingAccessApprovals && visibleNavItems.some((item) => item.to === '/admin/access');

  const primaryNavItems = useMemo<ComputedNavItem[]>(
    () =>
      visibleNavItems
        .filter((item) => item.desktopPlacement === 'primary')
        .map((item) => ({
          ...item,
          active: isNavItemActive(location.pathname, item.to),
          showAttentionDot: showAccessPendingAttention && item.to === '/admin/access'
        })),
    [location.pathname, showAccessPendingAttention, visibleNavItems]
  );
  const moreDesktopNavItems = useMemo<ComputedNavItem[]>(
    () =>
      visibleNavItems
        .filter((item) => item.desktopPlacement === 'more')
        .map((item) => ({
          ...item,
          active: isNavItemActive(location.pathname, item.to),
          showAttentionDot: showAccessPendingAttention && item.to === '/admin/access'
        })),
    [location.pathname, showAccessPendingAttention, visibleNavItems]
  );
  const primaryMobileNavItems = useMemo<ComputedNavItem[]>(
    () =>
      visibleNavItems
        .filter((item) => item.mobilePlacement === 'primary')
        .map((item) => ({
          ...item,
          active: isNavItemActive(location.pathname, item.to),
          showAttentionDot: showAccessPendingAttention && item.to === '/admin/access'
        })),
    [location.pathname, showAccessPendingAttention, visibleNavItems]
  );
  const moreMobileNavItems = useMemo<ComputedNavItem[]>(
    () =>
      visibleNavItems
        .filter((item) => item.mobilePlacement === 'more')
        .map((item) => ({
          ...item,
          active: isNavItemActive(location.pathname, item.to),
          showAttentionDot: showAccessPendingAttention && item.to === '/admin/access'
        })),
    [location.pathname, showAccessPendingAttention, visibleNavItems]
  );
  const primaryMobileItems = useMemo<MobileNavItem[]>(
    () =>
      primaryMobileNavItems.map((item) => ({
        label: item.mobileLabel,
        to: item.to,
        active: item.active,
        showAttentionDot: item.showAttentionDot,
        attentionAriaLabel: item.showAttentionDot ? `${item.mobileLabel} (pending approvals)` : undefined
      })),
    [primaryMobileNavItems]
  );
  const moreMobileItems = useMemo<MobileNavItem[]>(
    () =>
      moreMobileNavItems.map((item) => ({
        label: item.mobileLabel,
        to: item.to,
        active: item.active,
        showAttentionDot: item.showAttentionDot,
        attentionAriaLabel: item.showAttentionDot ? `${item.mobileLabel} (pending approvals)` : undefined
      })),
    [moreMobileNavItems]
  );
  const isDesktopMoreActive = moreDesktopNavItems.some((item) => item.active);
  const isMobileMoreActive = moreMobileNavItems.some((item) => item.active);

  useEffect(() => {
    closeMobileMoreSheet();
    closeDesktopMoreMenu();
  }, [closeDesktopMoreMenu, closeMobileMoreSheet, location.pathname]);

  useEffect(() => {
    hasMountedRef.current = true;
  }, []);

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

  const shouldAnimateRouteContent = hasMountedRef.current;

  return (
    <div
      className={`app-shell app-shell-theme-${appShellTheme} ${
        isPhoneLayout ? 'app-shell-phone' : ''
      }`.trim()}
    >
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
                  aria-label={showAccessPendingAttention ? 'More (pending approvals)' : 'More'}
                >
                  <span className="nav-attention-label">
                    More
                    {showAccessPendingAttention ? <span className="nav-attention-dot" aria-hidden="true" /> : null}
                  </span>
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
                        aria-label={item.showAttentionDot ? `${item.desktopLabel} (pending approvals)` : undefined}
                      >
                        <span className="nav-attention-label">
                          {item.desktopLabel}
                          {item.showAttentionDot ? <span className="nav-attention-dot" aria-hidden="true" /> : null}
                        </span>
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
        <div
          key={location.pathname}
          className={`route-content ${shouldAnimateRouteContent ? 'route-content-animate' : ''}`.trim()}
        >
          <Outlet />
        </div>
      </main>
      {isPhoneLayout ? (
        <>
          <MobileBottomNav
            items={primaryMobileItems}
            moreActive={isMobileMoreActive}
            isMoreOpen={isMobileMoreOpen}
            onOpenMore={toggleMobileMoreSheet}
            moreButtonRef={mobileMoreButtonRef}
            moreHasAttentionDot={showAccessPendingAttention}
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
