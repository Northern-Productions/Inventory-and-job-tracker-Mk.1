import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../../components/Button';
import { DialogSurface } from '../../components/DialogSurface';
import { ThemeToggle } from '../theme/ThemeToggle';
import { usePwaInstall } from '../pwa/PwaInstallContext';
import type { ManualInstallMode } from '../pwa/installUtils';
import { useAuth } from './AuthContext';
import { DefaultWarehouseControl } from './DefaultWarehouseControl';
import { OrganizationSwitcher } from './OrganizationSwitcher';
import { UsernameChangeControl } from './UsernameChangeControl';

function buildAccountRoleLine(role: string | null | undefined, pendingCount: number, showPending: boolean) {
  const trimmedRole = String(role || '').trim();
  if (!trimmedRole) {
    return '';
  }

  return `Role: ${trimmedRole}${showPending ? ` | Pending: ${pendingCount}` : ''}`;
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
    const horizontalPadding = 16;
    const menuWidth = Math.min(288, Math.max(0, window.innerWidth - horizontalPadding * 2));
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

  const accountName = auth.session.user.name || auth.session.user.email;
  const accountRoleLine = buildAccountRoleLine(
    auth.accessContext?.role,
    Number(auth.accessContext?.pendingCount || 0),
    auth.canAccessAdminConsole
  );

  const handleInstallClick = async () => {
    closeMenu();

    if (installState.installAvailability === 'native_prompt_available') {
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
      <div className="account-menu-profile" role="presentation">
        <strong className="account-menu-profile-name">{accountName}</strong>
        <span className="account-menu-profile-email">{auth.session.user.email}</span>
        {accountRoleLine ? (
          <span className="account-menu-profile-meta">{accountRoleLine}</span>
        ) : null}
      </div>
      <OrganizationSwitcher presentation="account-menu" />
      <UsernameChangeControl
        buttonVariant="ghost"
        buttonClassName="account-menu-item"
        buttonProps={{ role: 'menuitem' }}
      />
      <DefaultWarehouseControl
        buttonVariant="ghost"
        buttonClassName="account-menu-item"
        buttonProps={{ role: 'menuitem' }}
      />
      <Button
        type="button"
        variant="ghost"
        className="account-menu-item"
        role="menuitem"
        onClick={() => {
          closeMenu();
          void auth.refreshAccessContext();
        }}
      >
        Refresh Access
      </Button>
      {installState.installAvailability === 'already_installed' ? (
        <div className="account-menu-meta account-menu-meta-installed" role="status" aria-live="polite">
          App installed on this device
        </div>
      ) : installState.isInstallStatusReady && installState.installAvailability === 'native_prompt_available' ? (
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
      ) : installState.isInstallStatusReady && installState.installAvailability === 'manual_only' ? (
        <Button
          type="button"
          variant="ghost"
          className="account-menu-item account-menu-item-help"
          role="menuitem"
          onClick={() => {
            void handleInstallClick();
          }}
        >
          Install Help
        </Button>
      ) : null}
      <div className="account-menu-theme" role="presentation">
        <span className="account-menu-theme-label">Theme</span>
        <ThemeToggle />
      </div>
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
      <div className="dialog-header install-dialog-header">
        <div className="install-dialog-heading">
          <p className="install-dialog-eyebrow">Install App</p>
          <h2 id="install-app-dialog-title">{copy.title}</h2>
        </div>
        <button type="button" className="dialog-close" onClick={onClose} aria-label="Close install help">
          X
        </button>
      </div>
      <div className="install-dialog-body">
        <div className="install-dialog-intro-card">
          {copy.statusLine ? <p className="install-dialog-status">{copy.statusLine}</p> : null}
          <p id="install-app-dialog-description" className="install-dialog-lead">
            {copy.message}
          </p>
          <div className="install-dialog-note">
            <span className="install-dialog-note-label">Tip</span>
            <p>{copy.supportingNote}</p>
          </div>
        </div>
        <div className="install-dialog-section">
          <p className="install-dialog-section-label">Quick Steps</p>
          <ol className="install-steps">
            {copy.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      </div>
      <div className="dialog-actions install-dialog-actions">
        <Button type="button" variant="primary" onClick={onClose}>
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
      statusLine: 'Safari uses Add to Home Screen instead of one-click install.',
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
      statusLine: 'One-click install is not available in this browser session right now.',
      message:
        'You can still add this app to your home screen and launch it like a dedicated app.',
      steps: [
        'Open the browser menu.',
        'Tap Install app or Add to Home screen.',
        'Confirm the install.'
      ],
      supportingNote: 'If the prompt does not appear, Chrome usually gives the cleanest install experience.'
    };
  }

  return {
    title: 'Install On Your Computer',
    statusLine: 'One-click install is not available in this browser session right now.',
    message:
      'You can still install this site as its own app window with a start-menu or desktop icon.',
    steps: [
      'Open the browser menu.',
      'Choose Install App, Install Window Film Inventory, or Apps > Install this site as an app.',
      'Confirm the install.'
    ],
    supportingNote: 'Chrome or Edge usually gives the cleanest desktop install experience.'
  };
}
