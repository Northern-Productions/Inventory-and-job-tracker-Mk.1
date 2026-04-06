// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthGate } from './AuthGate';

const useAuthMock = vi.fn();

vi.mock('./AuthContext', () => ({
  useAuth: () => useAuthMock()
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

describe('AuthGate', () => {
  beforeEach(() => {
    useAuthMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders a Forgot Password action on the sign-in form', () => {
    useAuthMock.mockReturnValue(buildAuth());

    render(<AuthGate />);

    expect(screen.getByRole('button', { name: 'Forgot Password' })).toBeTruthy();
  });

  it('opens the forgot password modal and shows the email-sent confirmation', async () => {
    const requestPasswordReset = vi.fn().mockResolvedValue(undefined);
    useAuthMock.mockReturnValue(
      buildAuth({
        requestPasswordReset
      })
    );

    render(<AuthGate />);

    fireEvent.click(screen.getByRole('button', { name: 'Forgot Password' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Email'), {
      target: { value: 'user@example.com' }
    });
    fireEvent.submit(within(dialog).getByRole('button', { name: 'Send Reset Link' }).closest('form')!);

    expect(await screen.findByText('Check Your Email')).toBeTruthy();
    expect(requestPasswordReset).toHaveBeenCalledWith('user@example.com');
    expect(
      screen.getByText('If an account exists for that email, a password reset link has been sent.')
    ).toBeTruthy();
  });

  it('renders the reset-password form when password recovery is active', () => {
    useAuthMock.mockReturnValue(
      buildAuth({
        isPasswordRecovery: true,
        isAuthenticated: true
      })
    );

    render(<AuthGate />);

    expect(screen.getByRole('heading', { name: 'Reset your password' })).toBeTruthy();
    expect(screen.getByLabelText('New Password')).toBeTruthy();
    expect(screen.getByLabelText('Confirm Password')).toBeTruthy();
  });

  it('blocks recovery submit when the new passwords do not match', () => {
    const completePasswordReset = vi.fn().mockResolvedValue(undefined);
    useAuthMock.mockReturnValue(
      buildAuth({
        completePasswordReset,
        isPasswordRecovery: true,
        isAuthenticated: true
      })
    );

    render(<AuthGate />);

    fireEvent.change(screen.getByLabelText('New Password'), {
      target: { value: 'new-password' }
    });
    fireEvent.change(screen.getByLabelText('Confirm Password'), {
      target: { value: 'different-password' }
    });
    fireEvent.submit(screen.getByRole('button', { name: 'Save New Password' }).closest('form')!);

    expect(screen.getByText('The passwords do not match.')).toBeTruthy();
    expect(completePasswordReset).not.toHaveBeenCalled();
  });

  it('blocks recovery submit when the new password is shorter than 8 characters', () => {
    const completePasswordReset = vi.fn().mockResolvedValue(undefined);
    useAuthMock.mockReturnValue(
      buildAuth({
        completePasswordReset,
        isPasswordRecovery: true,
        isAuthenticated: true
      })
    );

    render(<AuthGate />);

    fireEvent.change(screen.getByLabelText('New Password'), {
      target: { value: 'short' }
    });
    fireEvent.change(screen.getByLabelText('Confirm Password'), {
      target: { value: 'short' }
    });
    fireEvent.submit(screen.getByRole('button', { name: 'Save New Password' }).closest('form')!);

    expect(screen.getByText('Use at least 8 characters for password.')).toBeTruthy();
    expect(completePasswordReset).not.toHaveBeenCalled();
  });
});
