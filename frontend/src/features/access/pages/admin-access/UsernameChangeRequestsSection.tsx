import { Button } from '../../../../components/Button';
import type { UsernameChangeRequestEntry } from '../../../../domain';
import { formatRoleLabel, getRolePillClassName } from './helpers';

interface UsernameChangeRequestsSectionProps {
  canWriteAccess: boolean;
  denyPending: boolean;
  error: Error | null;
  loading: boolean;
  requests: UsernameChangeRequestEntry[];
  approvePending: boolean;
  onApprove: (userId: string) => void;
  onDeny: (userId: string) => void;
}

export function UsernameChangeRequestsSection({
  canWriteAccess,
  denyPending,
  error,
  loading,
  requests,
  approvePending,
  onApprove,
  onDeny
}: UsernameChangeRequestsSectionProps) {
  return (
    <section className="panel">
      <div className="panel-title-row">
        <div>
          <h2>Username Change Requests</h2>
          <p className="muted-text">Non-admin username changes require approval.</p>
        </div>
      </div>
      {loading ? <p className="muted-text">Loading username change requests...</p> : null}
      {error ? <p className="error-text">{error.message || 'Username change requests could not be loaded.'}</p> : null}
      {!loading && !error ? (
        <div className="stack access-requests-list">
          {requests.length === 0 ? (
            <p className="muted-text">No pending username changes.</p>
          ) : (
            requests.map((entry) => (
              <article key={entry.userId} className="panel panel-subtle">
                <div className="panel-title-row">
                  <div>
                    <strong>{entry.currentName || entry.email || entry.userId}</strong>
                    {entry.email ? <p className="muted-text">{entry.email}</p> : null}
                    <p className="muted-text">
                      Requested username: <strong>{entry.requestedName || '--'}</strong>
                    </p>
                    <p className="muted-text access-request-meta">
                      <span>{entry.userId}</span>
                      <span>- {entry.status.toUpperCase()} -</span>
                      <span className={getRolePillClassName(entry.currentRole)}>
                        {formatRoleLabel(entry.currentRole)}
                      </span>
                    </p>
                    <p className="muted-text">
                      Requested: {entry.requestedAt || '--'} {entry.decidedAt ? `- Decided: ${entry.decidedAt}` : ''}
                    </p>
                    {entry.decisionNote ? <p className="muted-text">Note: {entry.decisionNote}</p> : null}
                  </div>
                  <div className="page-actions access-request-actions">
                    <Button
                      type="button"
                      onClick={() => onApprove(entry.userId)}
                      disabled={!canWriteAccess || approvePending}
                    >
                      Approve
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={() => onDeny(entry.userId)}
                      disabled={!canWriteAccess || denyPending}
                    >
                      Deny
                    </Button>
                  </div>
                </div>
              </article>
            ))
          )}
        </div>
      ) : null}
    </section>
  );
}
