import { useEffect, useRef } from 'react';
import { useAuth } from './AuthContext';

export function AuthGate() {
  const auth = useAuth();
  const buttonRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    auth.mountGoogleButton(buttonRef.current);
  }, [auth.clientIdConfigured, auth.isAuthenticated, auth.isReady, auth.session]);

  return (
    <div className="auth-gate">
      <section className="auth-gate-card" aria-label="Sign in required">
        <p className="eyebrow">Secure Access</p>
        <h1>Sign in to open Window Film Inventory</h1>
        <p className="auth-gate-copy">
          The app stays locked until the user clicks the Google sign-in button and Google returns
          a profile name.
        </p>

        {auth.clientIdConfigured ? (
          <>
            <div ref={buttonRef} className="google-signin-slot auth-gate-button-slot" />
            <p className="auth-note">
              {auth.isReady
                ? 'Use Sign in with Google to continue.'
                : 'Loading the Google sign-in button...'}
            </p>
          </>
        ) : (
          <p className="error-text">Set `VITE_GOOGLE_CLIENT_ID` to enable Google sign-in.</p>
        )}

        {auth.errorMessage ? <p className="error-text">{auth.errorMessage}</p> : null}
      </section>
    </div>
  );
}
