import { Button } from '../../components/Button';
import { useAuth } from './AuthContext';
import { UsernameChangeControl } from './UsernameChangeControl';
import { OrganizationSwitcher } from './OrganizationSwitcher';

interface AccessSplashProps {
  mode: 'pending' | 'denied' | 'org_selection_required' | 'no_access';
}

export function AccessSplash({ mode }: AccessSplashProps) {
  const auth = useAuth();

  const copyByMode = {
    pending: {
      title: 'Account Pending Approval',
      description:
        'Your account is waiting for review. An owner or admin must approve your membership before you can use the app.'
    },
    denied: {
      title: 'Access Denied',
      description: 'Your access request was denied. Contact an owner if this should be reviewed.'
    },
    org_selection_required: {
      title: 'Organization Selection Needed',
      description:
        'Choose the organization you want to open. No organization data loads until you make a selection.'
    },
    no_access: {
      title: 'No Organization Access',
      description:
        'No approved or pending organization access was found for this account. Contact an owner to be added to the correct company.'
    }
  };
  const { title, description } = copyByMode[mode];

  return (
    <div className="auth-gate">
      <section className="auth-gate-card" aria-label="Access status">
        <p className="eyebrow">Access Control</p>
        <h1>{title}</h1>
        <p className="auth-gate-copy">{description}</p>
        {mode === 'org_selection_required' ? <OrganizationSwitcher selectionRequired /> : null}
        <div className="auth-gate-actions access-splash-actions">
          {(mode === 'pending' || mode === 'denied') && (
            <UsernameChangeControl buttonVariant="ghost" />
          )}
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
