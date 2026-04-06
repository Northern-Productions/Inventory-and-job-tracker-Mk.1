// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Session } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from './AuthContext';
import {
  PASSWORD_RESET_REQUEST_MESSAGE,
  PASSWORD_RESET_SUCCESS_MESSAGE
} from './authRecovery';

const getAuthContextMock = vi.fn();
const requestUsernameChangeApiMock = vi.fn();
const setClientAccessContextMock = vi.fn();
const getStoredAuthSessionMock = vi.fn();
const setStoredAuthSessionMock = vi.fn();
const getSupabaseClientMock = vi.fn();
const isSupabaseAuthConfiguredMock = vi.fn();

let authStateChangeHandler: ((event: string, session: Session | null) => void) | null = null;
let getSessionMock: ReturnType<typeof vi.fn>;
let resetPasswordForEmailMock: ReturnType<typeof vi.fn>;
let updateUserMock: ReturnType<typeof vi.fn>;
let signOutMock: ReturnType<typeof vi.fn>;
let refreshSessionMock: ReturnType<typeof vi.fn>;
let signInWithPasswordMock: ReturnType<typeof vi.fn>;
let signUpMock: ReturnType<typeof vi.fn>;

vi.mock('../../api/features/authClient', () => ({
  getAuthContext: (...args: unknown[]) => getAuthContextMock(...args),
  requestUsernameChange: (...args: unknown[]) => requestUsernameChangeApiMock(...args),
  setClientAccessContext: (...args: unknown[]) => setClientAccessContextMock(...args)
}));

vi.mock('../../lib/storage', () => ({
  getStoredAuthSession: () => getStoredAuthSessionMock(),
  setStoredAuthSession: (...args: unknown[]) => setStoredAuthSessionMock(...args)
}));

vi.mock('../../lib/supabase', () => ({
  getSupabaseClient: () => getSupabaseClientMock(),
  isSupabaseAuthConfigured: () => isSupabaseAuthConfiguredMock()
}));

function createSession(overrides: Partial<Session> = {}): Session {
  return {
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: {
      id: 'user-1',
      app_metadata: {},
      aud: 'authenticated',
      created_at: '2026-04-06T00:00:00.000Z',
      email: 'user@example.com',
      phone: '',
      user_metadata: {
        full_name: 'User Example'
      }
    },
    ...overrides
  } as Session;
}

function Probe() {
  const auth = useAuth();

  return (
    <div>
      <div data-testid="ready">{String(auth.isReady)}</div>
      <div data-testid="authenticated">{String(auth.isAuthenticated)}</div>
      <div data-testid="recovery">{String(auth.isPasswordRecovery)}</div>
      <div data-testid="message">{auth.passwordResetMessage}</div>
      <div data-testid="error">{auth.errorMessage}</div>
      <button type="button" onClick={() => void auth.requestPasswordReset('user@example.com')}>
        request-reset
      </button>
      <button type="button" onClick={() => void auth.completePasswordReset('updated-password')}>
        complete-reset
      </button>
    </div>
  );
}

describe('AuthContext', () => {
  beforeEach(() => {
    authStateChangeHandler = null;
    getSessionMock = vi.fn().mockResolvedValue({
      data: { session: null },
      error: null
    });
    resetPasswordForEmailMock = vi.fn().mockResolvedValue({ data: {}, error: null });
    updateUserMock = vi.fn().mockResolvedValue({ data: { user: {} }, error: null });
    signOutMock = vi.fn().mockResolvedValue({ error: null });
    refreshSessionMock = vi.fn().mockResolvedValue({
      data: { session: null },
      error: null
    });
    signInWithPasswordMock = vi.fn().mockResolvedValue({ data: { session: null }, error: null });
    signUpMock = vi.fn().mockResolvedValue({ data: { session: null }, error: null });

    getSupabaseClientMock.mockReturnValue({
      auth: {
        getSession: getSessionMock,
        onAuthStateChange: vi.fn((callback: (event: string, session: Session | null) => void) => {
          authStateChangeHandler = callback;
          return {
            data: {
              subscription: {
                unsubscribe: vi.fn()
              }
            }
          };
        }),
        resetPasswordForEmail: resetPasswordForEmailMock,
        updateUser: updateUserMock,
        signOut: signOutMock,
        refreshSession: refreshSessionMock,
        signInWithPassword: signInWithPasswordMock,
        signUp: signUpMock
      }
    });
    isSupabaseAuthConfiguredMock.mockReturnValue(true);
    getStoredAuthSessionMock.mockReturnValue(null);
    getAuthContextMock.mockResolvedValue({
      orgId: 'org-1',
      accessStatus: 'approved',
      role: 'owner',
      permissions: {},
      isAdminConsoleAllowed: true,
      pendingCount: 0,
      receivesInAppNotifications: true
    });
    setStoredAuthSessionMock.mockReset();
    setClientAccessContextMock.mockReset();
    requestUsernameChangeApiMock.mockReset();
    window.history.replaceState({}, '', '/');
  });

  afterEach(() => {
    cleanup();
    window.history.replaceState({}, '', '/');
  });

  it('requests a password reset email and reports the generic success message', async () => {
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('ready').textContent).toBe('true');
    });

    fireEvent.click(screen.getByRole('button', { name: 'request-reset' }));

    await waitFor(() => {
      expect(resetPasswordForEmailMock).toHaveBeenCalledWith('user@example.com', {
        redirectTo: `${window.location.origin}/`
      });
    });

    expect(screen.getByTestId('message').textContent).toBe(PASSWORD_RESET_REQUEST_MESSAGE);
  });

  it('enters password recovery mode when a recovery session is loaded from the URL', async () => {
    window.history.replaceState({}, '', '/?type=recovery');
    getSessionMock.mockResolvedValue({
      data: { session: createSession() },
      error: null
    });

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('recovery').textContent).toBe('true');
      expect(screen.getByTestId('authenticated').textContent).toBe('true');
    });

    expect(window.location.search).toBe('');
  });

  it('updates the password, signs out, and clears recovery mode after a successful reset', async () => {
    window.history.replaceState({}, '', '/?type=recovery');
    getSessionMock.mockResolvedValue({
      data: { session: createSession() },
      error: null
    });

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('recovery').textContent).toBe('true');
    });

    fireEvent.click(screen.getByRole('button', { name: 'complete-reset' }));

    await waitFor(() => {
      expect(updateUserMock).toHaveBeenCalledWith({ password: 'updated-password' });
      expect(signOutMock).toHaveBeenCalledTimes(1);
    });

    expect(screen.getByTestId('recovery').textContent).toBe('false');
    expect(screen.getByTestId('authenticated').textContent).toBe('false');
    expect(screen.getByTestId('message').textContent).toBe(PASSWORD_RESET_SUCCESS_MESSAGE);
  });
});
