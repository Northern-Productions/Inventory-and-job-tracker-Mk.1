import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { useAuth } from './AuthContext';
import { UsernameChangeControl } from './UsernameChangeControl';

export function AccountControl() {
  const auth = useAuth();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeMenu = useCallback(() => setIsMenuOpen(false), []);

  useEffect(() => {
    if (!isMenuOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) {
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

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [closeMenu, isMenuOpen]);

  if (auth.isAuthenticated && auth.session) {
    return (
      <div className="auth-panel auth-panel-signed-in account-card">
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
        <div className="account-menu-wrap" ref={menuRef}>
          <button
            ref={menuButtonRef}
            type="button"
            className={`account-menu-button ${isMenuOpen ? 'account-menu-button-active' : ''}`.trim()}
            onClick={() => setIsMenuOpen((current) => !current)}
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
          {isMenuOpen ? (
            <div className="account-menu" role="menu" aria-label="Account actions">
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
