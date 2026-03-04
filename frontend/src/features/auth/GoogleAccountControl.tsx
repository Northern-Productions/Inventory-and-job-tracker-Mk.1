import { useEffect, useRef } from 'react';
import { Button } from '../../components/Button';
import { useAuth } from './AuthContext';

export function GoogleAccountControl() {
  const auth = useAuth();
  const buttonRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    auth.mountGoogleButton(buttonRef.current);
  }, [auth.clientIdConfigured, auth.isAuthenticated, auth.isReady, auth.session]);

  if (auth.isAuthenticated && auth.session) {
    return (
      <div className="auth-panel auth-panel-signed-in">
        <div className="auth-user">
          <span className="eyebrow">Signed In</span>
          <strong>{auth.session.user.name}</strong>
          <span className="auth-email">{auth.session.user.email}</span>
        </div>
        <Button type="button" variant="ghost" onClick={auth.signOut}>
          Sign Out
        </Button>
      </div>
    );
  }

  if (!auth.clientIdConfigured) {
    return (
      <div className="auth-panel">
        <p className="auth-note">Set `VITE_GOOGLE_CLIENT_ID` to enable Google sign-in.</p>
      </div>
    );
  }

  return (
    <div className="auth-panel">
      <div ref={buttonRef} className="google-signin-slot" />
      <p className="auth-note">Sign in with Google to create and change inventory.</p>
    </div>
  );
}
