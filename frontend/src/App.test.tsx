// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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
  RouterProvider: () => <div>ROUTER_PROVIDER</div>
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

describe('App', () => {
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
});
