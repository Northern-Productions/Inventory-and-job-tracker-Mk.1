import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../../components/Button';
import { useAuth } from './AuthContext';
import { UsernameChangeControl } from './UsernameChangeControl';

export function AccountSummary() {
  const auth = useAuth();

  if (auth.isAuthenticated && auth.session) {
    return (
      <div className="auth-panel account-card">
        <div className="auth-user">
          <strong>{auth.session.user.name}</strong>
          <span className="auth-email">{auth.session.user.email}</span>
          {auth.accessContext?.role ? (
            <span className="auth-email auth-role-line">
              Role: {auth.accessContext.role}
              {auth.canAccessAdminConsole ? ` | Pending: ${auth.accessContext.pendingCount}` : ''}
            </span>
          ) : null}
        </div>
      </div>
    );
  }

  if (!auth.clientIdConfigured) {
    return (
      <div className="auth-panel">
        <p className="auth-note">
          Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` to enable sign-in.
        </p>
      </div>
    );
  }

  return (
    <div className="auth-panel">
      <p className="auth-note">Sign in with email/password to create and change inventory.</p>
    </div>
  );
}

export function AccountMenuTrigger() {
  const auth = useAuth();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 });
  const menuSurfaceRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => setIsMenuOpen(false), []);
  const updateMenuPosition = useCallback(() => {
    const trigger = menuButtonRef.current;
    if (!trigger) {
      return;
    }

    const rect = trigger.getBoundingClientRect();
    const menuWidth = 224;
    const horizontalPadding = 16;
    const nextLeft = Math.min(
      Math.max(horizontalPadding, rect.right - menuWidth),
      Math.max(horizontalPadding, window.innerWidth - menuWidth - horizontalPadding)
    );

    setMenuPosition({
      top: rect.bottom + 8,
      left: nextLeft
    });
  }, []);

  useEffect(() => {
    if (!isMenuOpen) {
      return;
    }

    updateMenuPosition();

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuSurfaceRef.current?.contains(target) || menuButtonRef.current?.contains(target)) {
        return;
      }

      closeMenu();
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }

      event.preventDefault();
      closeMenu();
      menuButtonRef.current?.focus();
    };

    const handleViewportChange = () => {
      updateMenuPosition();
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleEscape);
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [closeMenu, isMenuOpen, updateMenuPosition]);

  if (!auth.isAuthenticated || !auth.session) {
    return null;
  }

  const accountMenu = isMenuOpen ? (
    <div
      ref={menuSurfaceRef}
      className="account-menu"
      role="menu"
      aria-label="Account actions"
      style={{
        top: `${menuPosition.top}px`,
        left: `${menuPosition.left}px`
      }}
    >
      <UsernameChangeControl
        buttonVariant="ghost"
        buttonClassName="account-menu-item"
        onOpen={closeMenu}
        buttonProps={{ role: 'menuitem' }}
      />
      <Button
        type="button"
        variant="ghost"
        className="account-menu-item"
        role="menuitem"
        onClick={() => {
          closeMenu();
          void auth.signOut();
        }}
      >
        Sign Out
      </Button>
    </div>
  ) : null;

  return (
    <>
      <div className="account-menu-wrap">
        <button
          ref={menuButtonRef}
          type="button"
          className={`account-menu-button ${isMenuOpen ? 'account-menu-button-active' : ''}`.trim()}
          onClick={() => {
            if (!isMenuOpen) {
              updateMenuPosition();
            }
            setIsMenuOpen((current) => !current);
          }}
          aria-haspopup="menu"
          aria-expanded={isMenuOpen}
          aria-label="Account actions"
        >
          <span className="account-menu-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        </button>
      </div>
      {accountMenu && typeof document !== 'undefined' ? createPortal(accountMenu, document.body) : accountMenu}
    </>
  );
}
