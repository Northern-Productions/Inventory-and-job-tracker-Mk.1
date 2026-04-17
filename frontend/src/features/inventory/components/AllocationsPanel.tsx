import { LoadingState } from '../../../components/LoadingState';
import {
  MobileField,
  MobileFieldList,
  MobileRecordCard,
  MobileRecordHeader
} from '../../../components/MobileRecordCard';
import { useIsPhoneLayout } from '../../../hooks/useIsPhoneLayout';
import { formatDate, formatDateTime } from '../../../lib/date';
import { useBoxAllocations } from '../hooks/useInventoryQueries';
import { getActiveAllocatedFeet } from '../utils/boxHelpers';

function renderDate(value: string): string {
  return value ? formatDate(value) : '--';
}

function renderDateTime(value: string): string {
  return value ? formatDateTime(value) : '--';
}

function formatAllocationFeet(allocatedFeet: number, coveredFeet: number, backedPhysicalFeet = allocatedFeet) {
  if (backedPhysicalFeet !== allocatedFeet || (coveredFeet > 0 && coveredFeet !== allocatedFeet)) {
    return `${allocatedFeet} reserved / ${backedPhysicalFeet} backed / ${coveredFeet} covered`;
  }

  return String(allocatedFeet);
}

function formatReservationState(value: string | undefined) {
  return value === 'WITH_INSTALL_DATE' ? 'Locked' : 'Placeholder';
}

export function AllocationsPanel({
  boxId,
  feetAvailable,
  lockedFeet = 0,
  placeholderFeet = 0,
  collapsed = false,
  onToggle
}: {
  boxId: string;
  feetAvailable: number;
  lockedFeet?: number;
  placeholderFeet?: number;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const isPhoneLayout = useIsPhoneLayout();
  const allocationsQuery = useBoxAllocations(boxId);
  const allocations = allocationsQuery.data || [];
  const activeAllocatedFeet = getActiveAllocatedFeet(allocations);
  const panelBodyId = `allocations-panel-body-${boxId}`;

  return (
    <section className={`panel ${collapsed ? 'panel-collapsed' : ''}`.trim()}>
      <div className="panel-title-row">
        <h2>Allocations</h2>
        {onToggle ? (
          <button
            type="button"
            className="panel-header-toggle"
            onClick={onToggle}
            aria-expanded={!collapsed}
            aria-controls={panelBodyId}
            aria-label={`${collapsed ? 'Expand' : 'Collapse'} allocations`}
          >
            <span className="muted-text panel-header-toggle-metadata">{boxId}</span>
            <span className="panel-header-toggle-symbol" aria-hidden="true">
              {collapsed ? '+' : '-'}
            </span>
          </button>
        ) : (
          <span className="muted-text">{boxId}</span>
        )}
      </div>
      <div id={panelBodyId} hidden={collapsed}>
        <div className="stat-grid allocation-stat-grid">
          <div className="key-value">
            <dt>Active Reserved LF</dt>
            <dd>{activeAllocatedFeet}</dd>
          </div>
          <div className="key-value">
            <dt>Locked LF</dt>
            <dd>{lockedFeet}</dd>
          </div>
          <div className="key-value">
            <dt>Placeholder LF</dt>
            <dd>{placeholderFeet}</dd>
          </div>
          <div className="key-value">
            <dt>Allocatable Now</dt>
            <dd>{feetAvailable}</dd>
          </div>
        </div>
        {allocationsQuery.isLoading ? <LoadingState label="Loading allocations..." /> : null}
        {allocationsQuery.isError ? <p className="error-text">{allocationsQuery.error.message}</p> : null}
        {!allocationsQuery.isLoading && !allocationsQuery.isError && !allocations.length ? (
          <div className="empty-state">No allocations saved for this box yet.</div>
        ) : null}
        {allocations.length ? (
          isPhoneLayout ? (
            <div className="mobile-record-list">
              {allocations.map((entry) => (
                <MobileRecordCard key={entry.allocationId}>
                  <MobileRecordHeader
                    title={entry.jobNumber}
                    subtitle={renderDateTime(entry.createdAt)}
                    badge={<span className={`badge badge-${entry.status}`}>{entry.status}</span>}
                  />
                  <MobileFieldList>
                    <MobileField label="Install Date" value={renderDate(entry.installDate)} />
                    <MobileField label="Crew" value={entry.crewLeader || '--'} />
                    <MobileField label="Reservation" value={formatReservationState(entry.reservationState)} />
                    <MobileField
                      label="LF"
                      value={formatAllocationFeet(entry.allocatedFeet, entry.coveredFeet, entry.backedPhysicalFeet)}
                    />
                    <MobileField label="Resolved" value={renderDateTime(entry.resolvedAt)} />
                  </MobileFieldList>
                </MobileRecordCard>
              ))}
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Created</th>
                    <th>Job</th>
                    <th>Install Date</th>
                    <th>Crew</th>
                    <th>Reservation</th>
                    <th>LF</th>
                    <th>Status</th>
                    <th>Resolved</th>
                  </tr>
                </thead>
                <tbody>
                  {allocations.map((entry) => (
                    <tr key={entry.allocationId}>
                      <td>{renderDateTime(entry.createdAt)}</td>
                      <td>{entry.jobNumber}</td>
                      <td>{renderDate(entry.installDate)}</td>
                      <td>{entry.crewLeader || '--'}</td>
                      <td>{formatReservationState(entry.reservationState)}</td>
                      <td>{formatAllocationFeet(entry.allocatedFeet, entry.coveredFeet, entry.backedPhysicalFeet)}</td>
                      <td>{entry.status}</td>
                      <td>{renderDateTime(entry.resolvedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : null}
      </div>
    </section>
  );
}
