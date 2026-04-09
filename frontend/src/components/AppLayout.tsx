import { useCallback, useEffect, useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useIsPhoneLayout } from '../hooks/useIsPhoneLayout';
import { AccountMenuTrigger } from '../features/auth/AccountControl';
import { DesktopNavigation } from './app-layout/DesktopNavigation';
import { MobileNavigation } from './app-layout/MobileNavigation';
import { useAppLayoutNavigation } from './app-layout/useAppLayoutNavigation';

export function AppLayout() {
  const location = useLocation();
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
      <header className="app-header">
        <div className="app-header-band">
          <div className="app-header-band-inner">
            <div className="app-header-topline">
              <div className="app-brand-block">
                <h1>Window Film Inventory</h1>
              </div>
              <div className="app-header-corner">
                <AccountMenuTrigger />
              </div>
            </div>
            {!isPhoneLayout ? (
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
              />
            ) : null}
          </div>
        </div>
      </header>
      <main className={`app-main ${isPhoneLayout ? 'app-main-phone' : ''}`.trim()}>
        <div
          key={location.pathname}
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
        />
      ) : null}
    </div>
  );
}
