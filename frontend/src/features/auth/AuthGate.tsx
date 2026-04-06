import { useState, type FormEvent } from 'react';
import { Button } from '../../components/Button';
import { useAuth } from './AuthContext';

export function AuthGate() {
  const auth = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState('');
  const [isForgotPasswordModalOpen, setIsForgotPasswordModalOpen] = useState(false);
  const [forgotPasswordStep, setForgotPasswordStep] = useState<'form' | 'sent'>('form');
  const [forgotPasswordEmail, setForgotPasswordEmail] = useState('');
  const [forgotPasswordError, setForgotPasswordError] = useState('');
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [createStep, setCreateStep] = useState<'form' | 'verify_email'>('form');
  const [createUsername, setCreateUsername] = useState('');
  const [createEmail, setCreateEmail] = useState('');
  const [createPassword, setCreatePassword] = useState('');
  const [createError, setCreateError] = useState('');
  const [recoveryPassword, setRecoveryPassword] = useState('');
  const [recoveryPasswordConfirm, setRecoveryPasswordConfirm] = useState('');
  const [recoveryError, setRecoveryError] = useState('');

  async function handleSignIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLocalError('');

    if (!email.trim() || !password) {
      setLocalError('Email and password are required.');
      return;
    }

    try {
      await auth.signInWithPassword(email, password);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'Sign-in failed.');
    }
  }

  function openCreateAccountModal() {
    setCreateStep('form');
    setCreateError('');
    setCreateUsername('');
    setCreateEmail(email.trim());
    setCreatePassword('');
    setIsCreateModalOpen(true);
  }

  function closeCreateAccountModal() {
    if (auth.isBusy) {
      return;
    }
    setIsCreateModalOpen(false);
    setCreateStep('form');
    setCreateError('');
    setCreatePassword('');
  }

  function openForgotPasswordModal() {
    setForgotPasswordStep('form');
    setForgotPasswordError('');
    setForgotPasswordEmail(email.trim());
    setIsForgotPasswordModalOpen(true);
  }

  function closeForgotPasswordModal() {
    if (auth.isBusy) {
      return;
    }

    setIsForgotPasswordModalOpen(false);
    setForgotPasswordStep('form');
    setForgotPasswordError('');
  }

  async function handleCreateAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreateError('');

    if (!createUsername.trim() || !createEmail.trim() || !createPassword) {
      setCreateError('Username, email, and password are required.');
      return;
    }

    if (createPassword.length < 8) {
      setCreateError('Use at least 8 characters for password.');
      return;
    }

    try {
      const result = await auth.signUpWithPassword(createUsername, createEmail, createPassword);
      setEmail(createEmail.trim());
      if (result.sessionCreated) {
        closeCreateAccountModal();
        return;
      }
      setCreateStep('verify_email');
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : 'Account creation failed.');
    }
  }

  function handleBackToSignIn() {
    setPassword('');
    closeCreateAccountModal();
  }

  async function handleForgotPasswordRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setForgotPasswordError('');

    if (!forgotPasswordEmail.trim()) {
      setForgotPasswordError('Email is required.');
      return;
    }

    try {
      await auth.requestPasswordReset(forgotPasswordEmail);
      setEmail(forgotPasswordEmail.trim());
      setForgotPasswordStep('sent');
    } catch (error) {
      setForgotPasswordError(
        error instanceof Error ? error.message : 'Password reset could not be requested.'
      );
    }
  }

  async function handlePasswordRecoverySubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRecoveryError('');

    if (!recoveryPassword || !recoveryPasswordConfirm) {
      setRecoveryError('Enter and confirm your new password.');
      return;
    }

    if (recoveryPassword.length < 8) {
      setRecoveryError('Use at least 8 characters for password.');
      return;
    }

    if (recoveryPassword !== recoveryPasswordConfirm) {
      setRecoveryError('The passwords do not match.');
      return;
    }

    try {
      await auth.completePasswordReset(recoveryPassword);
      setRecoveryPassword('');
      setRecoveryPasswordConfirm('');
    } catch (error) {
      setRecoveryError(error instanceof Error ? error.message : 'Password reset failed.');
    }
  }

  const isRecoveryLinkReady = auth.isReady && auth.isAuthenticated;

  return (
    <div className="auth-gate">
      {auth.isPasswordRecovery ? (
        <section className="auth-gate-card" aria-label="Reset password">
          <p className="eyebrow">Secure Access</p>
          <h1>Reset your password</h1>
          <p className="auth-gate-copy">
            Use the secure link from your email to set a new password.
          </p>

          {auth.clientIdConfigured ? (
            isRecoveryLinkReady ? (
              <form className="auth-gate-form" onSubmit={handlePasswordRecoverySubmit}>
                <label className="field">
                  <span className="field-label">New Password</span>
                  <input
                    type="password"
                    className="field-input"
                    value={recoveryPassword}
                    autoComplete="new-password"
                    onChange={(event) => setRecoveryPassword(event.target.value)}
                    placeholder="At least 8 characters"
                  />
                </label>
                <label className="field">
                  <span className="field-label">Confirm Password</span>
                  <input
                    type="password"
                    className="field-input"
                    value={recoveryPasswordConfirm}
                    autoComplete="new-password"
                    onChange={(event) => setRecoveryPasswordConfirm(event.target.value)}
                    placeholder="Repeat your new password"
                  />
                </label>
                <div className="auth-gate-actions">
                  <Button type="submit" disabled={auth.isBusy}>
                    {auth.isBusy ? 'Saving Password...' : 'Save New Password'}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={auth.isBusy}
                    onClick={auth.exitPasswordRecovery}
                  >
                    Back to Sign In
                  </Button>
                </div>
              </form>
            ) : (
              <p className="muted-text">Validating your reset link...</p>
            )
          ) : (
            <p className="error-text">
              Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` to enable password reset.
            </p>
          )}

          {recoveryError ? <p className="error-text">{recoveryError}</p> : null}
          {auth.errorMessage ? <p className="error-text">{auth.errorMessage}</p> : null}
        </section>
      ) : (
        <section className="auth-gate-card" aria-label="Sign in required">
          <p className="eyebrow">Secure Access</p>
          <h1>Sign in to open Window Film Inventory</h1>
          <p className="auth-gate-copy">
            The app stays locked until the user signs in with email and password.
          </p>

          {auth.clientIdConfigured ? (
            <form className="auth-gate-form" onSubmit={handleSignIn}>
              <label className="field">
                <span className="field-label">Email</span>
                <input
                  type="email"
                  className="field-input"
                  value={email}
                  autoComplete="email"
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                />
              </label>
              <label className="field">
                <span className="field-label">Password</span>
                <input
                  type="password"
                  className="field-input"
                  value={password}
                  autoComplete="current-password"
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="At least 8 characters"
                />
              </label>
              <div className="auth-gate-actions">
                <Button type="submit" disabled={auth.isBusy || !auth.isReady}>
                  {auth.isBusy ? 'Signing In...' : 'Sign In'}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={auth.isBusy || !auth.isReady}
                  onClick={openCreateAccountModal}
                >
                  Create Account
                </Button>
              </div>
              <div className="auth-gate-actions">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={auth.isBusy || !auth.isReady}
                  onClick={openForgotPasswordModal}
                >
                  Forgot Password
                </Button>
              </div>
              <p className="auth-note">Use Create Account once, then sign in with the same email.</p>
            </form>
          ) : (
            <p className="error-text">
              Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` to enable sign-in.
            </p>
          )}

          {auth.passwordResetMessage ? <p className="muted-text">{auth.passwordResetMessage}</p> : null}
          {localError ? <p className="error-text">{localError}</p> : null}
          {auth.errorMessage ? <p className="error-text">{auth.errorMessage}</p> : null}
        </section>
      )}

      {isCreateModalOpen ? (
        <div className="dialog-backdrop" role="presentation">
          <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="create-account-title">
            <div className="dialog-header">
              <h2 id="create-account-title">
                {createStep === 'form' ? 'Create Account' : 'Check Your Email'}
              </h2>
              <button
                type="button"
                className="dialog-close"
                aria-label="Close create account modal"
                onClick={closeCreateAccountModal}
                disabled={auth.isBusy}
              >
                X
              </button>
            </div>

            {createStep === 'form' ? (
              <form className="auth-gate-form" onSubmit={handleCreateAccount}>
                <label className="field">
                  <span className="field-label">Username</span>
                  <input
                    type="text"
                    className="field-input"
                    value={createUsername}
                    autoComplete="nickname"
                    onChange={(event) => setCreateUsername(event.target.value)}
                    placeholder="Preferred display name"
                  />
                </label>
                <label className="field">
                  <span className="field-label">Email</span>
                  <input
                    type="email"
                    className="field-input"
                    value={createEmail}
                    autoComplete="email"
                    onChange={(event) => setCreateEmail(event.target.value)}
                    placeholder="you@example.com"
                  />
                </label>
                <label className="field">
                  <span className="field-label">Password</span>
                  <input
                    type="password"
                    className="field-input"
                    value={createPassword}
                    autoComplete="new-password"
                    onChange={(event) => setCreatePassword(event.target.value)}
                    placeholder="At least 8 characters"
                  />
                </label>
                <div className="dialog-actions">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={closeCreateAccountModal}
                    disabled={auth.isBusy}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={auth.isBusy || !auth.isReady}>
                    {auth.isBusy ? 'Creating Account...' : 'Create Account'}
                  </Button>
                </div>
                {createError ? <p className="error-text">{createError}</p> : null}
              </form>
            ) : (
              <>
                <p className="muted-text">
                  Account created. Verify your email address, then return to sign in.
                </p>
                <p className="muted-text">
                  Owners and admins are notified after your verified sign-in creates the access request.
                </p>
                <div className="dialog-actions">
                  <Button type="button" onClick={handleBackToSignIn}>
                    Back to Sign In
                  </Button>
                </div>
              </>
            )}
          </section>
        </div>
      ) : null}

      {isForgotPasswordModalOpen ? (
        <div className="dialog-backdrop" role="presentation">
          <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="forgot-password-title">
            <div className="dialog-header">
              <h2 id="forgot-password-title">
                {forgotPasswordStep === 'form' ? 'Forgot Password' : 'Check Your Email'}
              </h2>
              <button
                type="button"
                className="dialog-close"
                aria-label="Close forgot password modal"
                onClick={closeForgotPasswordModal}
                disabled={auth.isBusy}
              >
                X
              </button>
            </div>

            {forgotPasswordStep === 'form' ? (
              <form className="auth-gate-form" onSubmit={handleForgotPasswordRequest}>
                <label className="field">
                  <span className="field-label">Email</span>
                  <input
                    type="email"
                    className="field-input"
                    value={forgotPasswordEmail}
                    autoComplete="email"
                    onChange={(event) => setForgotPasswordEmail(event.target.value)}
                    placeholder="you@example.com"
                  />
                </label>
                <p className="muted-text">
                  We&apos;ll send a secure reset link to the email you used when you created your account.
                </p>
                <div className="dialog-actions">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={closeForgotPasswordModal}
                    disabled={auth.isBusy}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={auth.isBusy || !auth.isReady}>
                    {auth.isBusy ? 'Sending Reset Link...' : 'Send Reset Link'}
                  </Button>
                </div>
                {forgotPasswordError ? <p className="error-text">{forgotPasswordError}</p> : null}
              </form>
            ) : (
              <>
                <p className="muted-text">
                  {auth.passwordResetMessage ||
                    'If an account exists for that email, a password reset link has been sent.'}
                </p>
                <p className="muted-text">
                  Open the link in that email, then return here to set a new password.
                </p>
                <div className="dialog-actions">
                  <Button type="button" onClick={closeForgotPasswordModal}>
                    Back to Sign In
                  </Button>
                </div>
              </>
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}

