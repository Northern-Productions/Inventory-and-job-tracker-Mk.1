import { Button } from '../../components/Button';
import { useAuth } from './AuthContext';
import { UsernameChangeControl } from './UsernameChangeControl';

interface AccessSplashProps {
  mode: 'pending' | 'denied';
}

export function AccessSplash({ mode }: AccessSplashProps) {
  const auth = useAuth();

  const title =
    mode === 'pending' ? 'Account Pending Approval' : 'Access Denied';
  const description =
    mode === 'pending'
      ? 'Your account is waiting for review. An owner or admin must approve your membership before you can use the app.'
      : 'Your access request was denied. Contact an owner if this should be reviewed.';

  return (
    <div className="auth-gate">
      <section className="auth-gate-card" aria-label="Access status">
        <p className="eyebrow">Access Control</p>
        <h1>{title}</h1>
        <p className="auth-gate-copy">{description}</p>
        <div className="auth-gate-actions access-splash-actions">
          <UsernameChangeControl buttonVariant="ghost" />
          <Button type="button" variant="secondary" onClick={() => void auth.refreshAccessContext()}>
            Refresh Status
          </Button>
          <Button type="button" variant="ghost" onClick={() => void auth.signOut()}>
            Sign Out
          </Button>
        </div>
      </section>
    </div>
  );
}
