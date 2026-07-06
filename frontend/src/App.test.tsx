// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';

const useAuthMock = vi.fn();

vi.mock('./features/auth/AuthContext', () => ({
  useAuth: () => useAuthMock()
}));

vi.mock('./features/auth/AuthGate', () => ({
  AuthGate: () => <div>AUTH_GATE</div>
}));

vi.mock('./features/auth/AccessSplash', () => ({
  AccessSplash: ({ mode }: { mode: string }) => <div>{`ACCESS_SPLASH:${mode}`}</div>
}));

vi.mock('./components/DeferredLoadingState', () => ({
  DeferredLoadingState: ({ label }: { label?: string }) => <div>{label || 'Loading...'}</div>
}));

vi.mock('./routes', () => ({
  router: {}
}));

vi.mock('react-router-dom', () => ({
  RouterProvider: () => (
    <div>
      <div>ROUTER_PROVIDER</div>
      <input aria-label="Protected draft field" defaultValue="unsaved draft" />
    </div>
  )
}));

vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: () => ({
    needRefresh: [false],
    updateServiceWorker: vi.fn()
  })
}));

function buildAuth(overrides: Record<string, unknown> = {}) {
  return {
    accessContext: null,
    accessRefreshError: '',
    accessStatus: '',
    canAccessAdminConsole: false,
    clientIdConfigured: true,
    completePasswordReset: vi.fn().mockResolvedValue(undefined),
    errorMessage: '',
    exitPasswordRecovery: vi.fn(),
    hasFeatureAccess: vi.fn(() => false),
    isAccessReady: true,
    isAdmin: false,
    isApproved: false,
    isAuthenticated: false,
    isBusy: false,
    isMember: false,
    isOwner: false,
    isPasswordRecovery: false,
    isReady: true,
    passwordResetMessage: '',
    refreshAccessContext: vi.fn().mockResolvedValue(undefined),
    requestPasswordReset: vi.fn().mockResolvedValue(undefined),
    requestUsernameChange: vi.fn().mockResolvedValue({
      status: 'approved',
      requiresApproval: false,
      username: 'tester'
    }),
    session: null,
    signInWithPassword: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn().mockResolvedValue(undefined),
    signUpWithPassword: vi.fn().mockResolvedValue({ sessionCreated: false }),
    ...overrides
  };
}

function buildAccessContext(overrides: Record<string, unknown> = {}) {
  return {
    orgId: 'org-1',
    accessStatus: 'approved',
    role: 'owner',
    permissions: {},
    isAdminConsoleAllowed: true,
    pendingCount: 0,
    receivesInAppNotifications: true,
    ...overrides
  };
}

describe('App', () => {
  beforeEach(() => {
    useAuthMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the auth gate during password recovery even before normal auth access is ready', () => {
    useAuthMock.mockReturnValue(
      buildAuth({
        isPasswordRecovery: true,
        isReady: false,
        isAuthenticated: false
      })
    );

    render(<App />);

    expect(screen.getByText('AUTH_GATE')).toBeTruthy();
    expect(screen.queryByText('ROUTER_PROVIDER')).toBeNull();
  });

  it('shows the access permissions loader during initial authenticated access load', () => {
    useAuthMock.mockReturnValue(
      buildAuth({
        isAuthenticated: true,
        isAccessReady: false,
        accessContext: null
      })
    );

    render(<App />);

    expect(screen.getByText('Loading your access permissions...')).toBeTruthy();
    expect(screen.queryByText('ROUTER_PROVIDER')).toBeNull();
  });

  it('keeps protected content mounted during a background access refresh with existing context', () => {
    useAuthMock.mockReturnValue(
      buildAuth({
        accessContext: buildAccessContext(),
        accessStatus: 'approved',
        isAccessReady: false,
        isApproved: true,
        isAuthenticated: true,
        isOwner: true
      })
    );

    render(<App />);

    expect(screen.getByText('ROUTER_PROVIDER')).toBeTruthy();
    expect(screen.getByLabelText('Protected draft field')).toBeTruthy();
    expect(screen.queryByText('Loading your access permissions...')).toBeNull();
  });

  it('still renders the denied access splash for denied access context', () => {
    useAuthMock.mockReturnValue(
      buildAuth({
        accessContext: buildAccessContext({ accessStatus: 'denied', role: 'member' }),
        accessStatus: 'denied',
        isAccessReady: true,
        isApproved: false,
        isAuthenticated: true,
        isMember: true
      })
    );

    render(<App />);

    expect(screen.getByText('ACCESS_SPLASH:denied')).toBeTruthy();
    expect(screen.queryByText('ROUTER_PROVIDER')).toBeNull();
  });

  it('renders the org selection safe state without mounting protected routes', () => {
    useAuthMock.mockReturnValue(
      buildAuth({
        accessContext: buildAccessContext({ accessStatus: 'org_selection_required', role: '' }),
        accessStatus: 'org_selection_required',
        isAccessReady: true,
        isApproved: false,
        isAuthenticated: true
      })
    );

    render(<App />);

    expect(screen.getByText('ACCESS_SPLASH:org_selection_required')).toBeTruthy();
    expect(screen.queryByText('ROUTER_PROVIDER')).toBeNull();
  });

  it('renders the no-access safe state without mounting protected routes', () => {
    useAuthMock.mockReturnValue(
      buildAuth({
        accessContext: buildAccessContext({ accessStatus: 'no_access', role: '' }),
        accessStatus: 'no_access',
        isAccessReady: true,
        isApproved: false,
        isAuthenticated: true
      })
    );

    render(<App />);

    expect(screen.getByText('ACCESS_SPLASH:no_access')).toBeTruthy();
    expect(screen.queryByText('ROUTER_PROVIDER')).toBeNull();
  });
});
