import { useCallback, useEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useIsPhoneLayout } from '../hooks/useIsPhoneLayout';
import { AccountMenuTrigger } from '../features/auth/AccountControl';
import { OrganizationSwitcher } from '../features/auth/OrganizationSwitcher';
import { useDefaultWarehouseLabel } from '../features/inventory/hooks/useDefaultWarehouse';
import {
  NavigationCoordinatorProvider,
  useNavigationCoordinator
} from '../features/navigation/NavigationCoordinator';
import { LIST_ROUTE_KINDS } from '../features/navigation/navigationSession';
import { DesktopNavigation } from './app-layout/DesktopNavigation';
import { MobileNavigation } from './app-layout/MobileNavigation';
import { useAppLayoutNavigation } from './app-layout/useAppLayoutNavigation';
import { ShareCurrentPageButton } from './ShareCurrentPageButton';

export function AppLayout() {
  return (
    <NavigationCoordinatorProvider>
      <AppLayoutShell />
    </NavigationCoordinatorProvider>
  );
}

function AppLayoutShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const navigationCoordinator = useNavigationCoordinator();
  const isPhoneLayout = useIsPhoneLayout();
  const {
    appShellTheme,
    primaryNavItems,
    moreDesktopNavItems,
    primaryMobileItems,
    moreMobileItems,
    isDesktopMoreActive,
    isMobileMoreActive,
    desktopMoreHasAttention,
    mobileMoreHasAttention,
    mobileMoreAttentionAriaLabel
  } = useAppLayoutNavigation(location.pathname);
  const defaultWarehouseLabel = useDefaultWarehouseLabel();
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
  const handleMainDefault = useCallback(
    (path: '/' | '/allocations') => {
      navigationCoordinator?.requestMainDefaultReset(
        path === '/' ? LIST_ROUTE_KINDS.INVENTORY : LIST_ROUTE_KINDS.JOBS_CALENDAR
      );
      navigate(path, {
        replace: location.pathname === path
      });
    },
    [location.pathname, navigate, navigationCoordinator]
  );

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

  return (
    <div
      className={`app-shell app-shell-theme-${appShellTheme} ${
        isPhoneLayout ? 'app-shell-phone' : ''
      }`.trim()}
    >
      <header className={`app-header ${!isPhoneLayout ? 'app-header-desktop' : ''}`.trim()}>
        <div className="app-header-band">
          <div className="app-header-band-inner">
            <div className="app-header-topline">
              <div className="app-brand-block">
                <h1>Window Film Inventory</h1>
              </div>
              <div className="app-header-corner">
                <OrganizationSwitcher />
                <span className="app-header-warehouse" title={`Warehouse: ${defaultWarehouseLabel}`}>
                  Warehouse: {defaultWarehouseLabel}
                </span>
                <ShareCurrentPageButton />
                <AccountMenuTrigger />
              </div>
            </div>
          </div>
        </div>
      </header>
      {!isPhoneLayout ? (
        <div className="app-header-nav-wrap">
          <DesktopNavigation
            primaryItems={primaryNavItems}
            moreItems={moreDesktopNavItems}
            moreRef={desktopMoreRef}
            isMoreActive={isDesktopMoreActive}
            isMoreOpen={isDesktopMoreOpen}
            moreHasAttention={desktopMoreHasAttention}
            moreAttentionAriaLabel={mobileMoreAttentionAriaLabel}
            onToggleMore={toggleDesktopMoreMenu}
            onCloseMore={closeDesktopMoreMenu}
            onMainDefault={handleMainDefault}
          />
        </div>
      ) : null}
      <main className={`app-main ${isPhoneLayout ? 'app-main-phone' : ''}`.trim()}>
        <div
          key={`${location.pathname}:${navigationCoordinator?.resetEpoch || 0}`}
          className={`route-content ${hasMountedRef.current ? 'route-content-animate' : ''}`.trim()}
        >
          <Outlet />
        </div>
      </main>
      {isPhoneLayout ? (
        <MobileNavigation
          primaryItems={primaryMobileItems}
          moreItems={moreMobileItems}
          activePath={location.pathname}
          isMoreActive={isMobileMoreActive}
          isMoreOpen={isMobileMoreOpen}
          moreButtonRef={mobileMoreButtonRef}
          moreHasAttention={mobileMoreHasAttention}
          moreAttentionAriaLabel={mobileMoreAttentionAriaLabel}
          onToggleMore={toggleMobileMoreSheet}
          onCloseMore={closeMobileMoreSheet}
          onMainDefault={handleMainDefault}
        />
      ) : null}
    </div>
  );
}
