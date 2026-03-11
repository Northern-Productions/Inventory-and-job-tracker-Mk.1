import { Button } from '../../components/Button';
import { useAuth } from './AuthContext';
import { UsernameChangeControl } from './UsernameChangeControl';

export function AccountControl() {
  const auth = useAuth();

  if (auth.isAuthenticated && auth.session) {
    return (
      <div className="auth-panel auth-panel-signed-in">
        <div className="auth-user">
          <span className="eyebrow">Signed In</span>
          <strong>{auth.session.user.name}</strong>
          <span className="auth-email">{auth.session.user.email}</span>
          {auth.accessContext?.role ? (
            <span className="auth-email">
              Role: {auth.accessContext.role}
              {auth.canAccessAdminConsole ? ` · Pending: ${auth.accessContext.pendingCount}` : ''}
            </span>
          ) : null}
        </div>
        <div className="auth-panel-actions">
          <UsernameChangeControl buttonVariant="ghost" />
          <Button type="button" variant="ghost" onClick={auth.signOut}>
            Sign Out
          </Button>
        </div>
      </div>
    );
  }

  if (!auth.clientIdConfigured) {
    return (
      <div className="auth-panel">
        <p className="auth-note">
          Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` to enable sign-in.
        </p>
      </div>
    );
  }

  return (
    <div className="auth-panel">
      <p className="auth-note">Sign in with email/password to create and change inventory.</p>
    </div>
  );
}
