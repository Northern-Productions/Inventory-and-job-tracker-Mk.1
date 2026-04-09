import { Button } from '../../../../components/Button';
import type { AccessRequestEntry } from '../../../../domain';
import {
  type AccessRequestStatusFilter,
  formatRoleLabel,
  getRolePillClassName
} from './helpers';

interface AccessRequestsSectionProps {
  canWriteAccess: boolean;
  denyPending: boolean;
  error: Error | null;
  isOwner: boolean;
  loading: boolean;
  permissionsMutationPending: boolean;
  requests: AccessRequestEntry[];
  requestsSummary: string;
  statusFilter: AccessRequestStatusFilter;
  approvePending: boolean;
  onApprove: (userId: string) => void;
  onChangePermissions: (entry: AccessRequestEntry) => void;
  onDeny: (userId: string) => void;
  onStatusFilterChange: (status: AccessRequestStatusFilter) => void;
}

export function AccessRequestsSection({
  canWriteAccess,
  denyPending,
  error,
  isOwner,
  loading,
  permissionsMutationPending,
  requests,
  requestsSummary,
  statusFilter,
  approvePending,
  onApprove,
  onChangePermissions,
  onDeny,
  onStatusFilterChange
}: AccessRequestsSectionProps) {
  return (
    <section className="panel">
      <div className="panel-title-row">
        <div>
          <h2>Access Requests</h2>
          <p className="muted-text">{requestsSummary}</p>
        </div>
        <div className="page-actions">
          <Button
            type="button"
            variant={statusFilter === '' ? 'primary' : 'ghost'}
            onClick={() => onStatusFilterChange('')}
          >
            All
          </Button>
          <Button
            type="button"
            variant={statusFilter === 'pending' ? 'primary' : 'ghost'}
            onClick={() => onStatusFilterChange('pending')}
          >
            Pending
          </Button>
          <Button
            type="button"
            variant={statusFilter === 'approved' ? 'primary' : 'ghost'}
            onClick={() => onStatusFilterChange('approved')}
          >
            Approved
          </Button>
          <Button
            type="button"
            variant={statusFilter === 'denied' ? 'primary' : 'ghost'}
            onClick={() => onStatusFilterChange('denied')}
          >
            Denied
          </Button>
        </div>
      </div>

      {loading ? <p className="muted-text">Loading access requests...</p> : null}
      {error ? <p className="error-text">{error.message || 'Access requests could not be loaded.'}</p> : null}

      {!loading && !error ? (
        <div className="stack access-requests-list">
          {requests.length === 0 ? (
            <p className="muted-text">No access requests found.</p>
          ) : (
            requests.map((entry) => {
              const isPending = entry.status === 'pending';
              const canChangePermissions =
                isOwner &&
                entry.status === 'approved' &&
                (entry.currentRole === 'member' || entry.currentRole === 'admin');
              const displayName = entry.name || entry.email || entry.userId;

              return (
                <article key={entry.userId} className="panel panel-subtle">
                  <div className="panel-title-row">
                    <div>
                      <strong>{displayName}</strong>
                      {entry.email ? <p className="muted-text">{entry.email}</p> : null}
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
                      {isPending ? (
                        <>
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
                        </>
                      ) : null}
                      {canChangePermissions ? (
                        <Button
                          type="button"
                          variant="ghost"
                          onClick={() => onChangePermissions(entry)}
                          disabled={permissionsMutationPending}
                        >
                          Change Permissions
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </article>
              );
            })
          )}
        </div>
      ) : null}
    </section>
  );
}
