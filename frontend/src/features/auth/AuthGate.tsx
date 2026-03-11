import { useState, type FormEvent } from 'react';
import { Button } from '../../components/Button';
import { useAuth } from './AuthContext';

export function AuthGate() {
  const auth = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState('');
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [createStep, setCreateStep] = useState<'form' | 'verify_email'>('form');
  const [createUsername, setCreateUsername] = useState('');
  const [createEmail, setCreateEmail] = useState('');
  const [createPassword, setCreatePassword] = useState('');
  const [createError, setCreateError] = useState('');

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

  return (
    <div className="auth-gate">
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
            <p className="auth-note">Use Create Account once, then sign in with the same email.</p>
          </form>
        ) : (
          <p className="error-text">
            Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` to enable sign-in.
          </p>
        )}

        {localError ? <p className="error-text">{localError}</p> : null}
        {auth.errorMessage ? <p className="error-text">{auth.errorMessage}</p> : null}
      </section>

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
    </div>
  );
}

