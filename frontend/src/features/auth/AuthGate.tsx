import { useState, type FormEvent } from 'react';
import { Button } from '../../components/Button';
import { useAuth } from './AuthContext';

export function AuthGate() {
  const auth = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState('');

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

  async function handleCreateAccount() {
    setLocalError('');

    if (!email.trim() || !password) {
      setLocalError('Email and password are required.');
      return;
    }

    if (password.length < 8) {
      setLocalError('Use at least 8 characters for password.');
      return;
    }

    try {
      await auth.signUpWithPassword(email, password);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'Account creation failed.');
    }
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
                onClick={handleCreateAccount}
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
    </div>
  );
}
