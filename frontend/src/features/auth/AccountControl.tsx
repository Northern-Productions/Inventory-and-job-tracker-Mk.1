import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../../components/Button';
import { DialogSurface } from '../../components/DialogSurface';
import { usePwaInstall } from '../pwa/PwaInstallContext';
import type { ManualInstallMode } from '../pwa/installUtils';
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
  const installState = usePwaInstall();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isInstallHelpOpen, setIsInstallHelpOpen] = useState(false);
  const [isOpeningInstallPrompt, setIsOpeningInstallPrompt] = useState(false);
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

  const handleInstallClick = async () => {
    closeMenu();

    if (installState.canInstall) {
      setIsOpeningInstallPrompt(true);
      try {
        const outcome = await installState.install();
        if (outcome === 'unavailable') {
          setIsInstallHelpOpen(true);
        }
      } finally {
        setIsOpeningInstallPrompt(false);
      }
      return;
    }

    setIsInstallHelpOpen(true);
  };

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
      {installState.isInstalled ? (
        <div className="account-menu-meta account-menu-meta-installed" role="status" aria-live="polite">
          App installed on this device
        </div>
      ) : installState.isInstallSupported ? (
        <Button
          type="button"
          variant="ghost"
          className="account-menu-item"
          role="menuitem"
          disabled={isOpeningInstallPrompt}
          onClick={() => {
            void handleInstallClick();
          }}
        >
          Install App
        </Button>
      ) : null}
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
      <InstallAppHelpDialog
        open={isInstallHelpOpen}
        manualInstallMode={installState.manualInstallMode}
        onClose={() => setIsInstallHelpOpen(false)}
      />
    </>
  );
}

function InstallAppHelpDialog({
  manualInstallMode,
  onClose,
  open
}: {
  manualInstallMode: ManualInstallMode;
  onClose: () => void;
  open: boolean;
}) {
  const copy = getInstallHelpCopy(manualInstallMode);

  return (
    <DialogSurface
      open={open}
      onClose={onClose}
      className="install-dialog"
      closeOnBackdrop
      titleId="install-app-dialog-title"
      descriptionId="install-app-dialog-description"
    >
      <div className="dialog-header">
        <h2 id="install-app-dialog-title">{copy.title}</h2>
        <button type="button" className="dialog-close" onClick={onClose} aria-label="Close install help">
          X
        </button>
      </div>
      <div className="dialog-copy">
        <p id="install-app-dialog-description">{copy.message}</p>
        <p>{copy.supportingNote}</p>
      </div>
      <ol className="install-steps">
        {copy.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <div className="dialog-actions">
        <Button type="button" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </div>
    </DialogSurface>
  );
}

function getInstallHelpCopy(manualInstallMode: ManualInstallMode) {
  if (manualInstallMode === 'ios') {
    return {
      title: 'Add To Home Screen',
      message:
        'Install this app from Safari so it opens from your home screen like a dedicated app instead of a regular browser tab.',
      steps: [
        'Open this site in Safari.',
        'Tap the Share button in the browser toolbar.',
        'Choose Add to Home Screen.',
        'Tap Add to place the app icon on your home screen.'
      ],
      supportingNote: 'After that, you can launch it from the home screen just like any other app.'
    };
  }

  if (manualInstallMode === 'android') {
    return {
      title: 'Install On This Phone',
      message:
        'Android browsers can pin this app to your home screen and open it in a standalone app window.',
      steps: [
        'Open the browser menu.',
        'Tap Install app or Add to Home screen.',
        'Confirm the install when your browser asks.'
      ],
      supportingNote: 'If the prompt does not appear, Chrome usually gives the cleanest install experience.'
    };
  }

  return {
    title: 'Install On Your Computer',
    message:
      'Desktop Chrome and Edge can install this site as its own app window with a start-menu or desktop icon.',
    steps: [
      'Open the browser menu.',
      'Choose Install App, Install Window Film Inventory, or Apps > Install this site as an app.',
      'Confirm the install when prompted.'
    ],
    supportingNote: 'If your current browser does not show an install option, open the app in Chrome or Edge.'
  };
}
