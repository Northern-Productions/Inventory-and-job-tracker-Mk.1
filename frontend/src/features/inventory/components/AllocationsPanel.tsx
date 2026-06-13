import { LoadingState } from '../../../components/LoadingState';
import { Link } from 'react-router-dom';
import {
  MobileField,
  MobileFieldList,
  MobileRecordCard,
  MobileRecordHeader
} from '../../../components/MobileRecordCard';
import { useIsPhoneLayout } from '../../../hooks/useIsPhoneLayout';
import { formatDate } from '../../../lib/date';
import { formatJobDisplayLabel } from '../../../lib/jobDisplay';
import { useBoxAllocations } from '../hooks/useInventoryQueries';
import { buildAllocationJobRoute } from '../utils/jobRoutes';
import type { AllocationEntry } from '../../../domain';

function renderDate(value: string): string {
  return value ? formatDate(value) : '--';
}

function formatClaimedFeet(allocatedFeet: number) {
  return `${allocatedFeet} LF`;
}

function formatJobLabel(entry: AllocationEntry) {
  return formatJobDisplayLabel(entry) || '--';
}

function renderWorkScope(entry: AllocationEntry) {
  return String(entry.workScope || entry.sections || '').trim() || '--';
}

function renderPlanningState(entry: AllocationEntry) {
  const normalizedState = String(entry.reservationState || '').trim().toUpperCase();
  if (normalizedState === 'WITH_INSTALL_DATE' || entry.installDate) {
    return 'Scheduled';
  }
  return 'Placeholder';
}

function renderJobValue(entry: AllocationEntry) {
  const label = formatJobLabel(entry);
  return entry.jobId ? <Link to={buildAllocationJobRoute(entry)}>{label}</Link> : label;
}

export function AllocationsPanel({
  boxId,
  collapsed = false,
  onToggle
}: {
  boxId: string;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const isPhoneLayout = useIsPhoneLayout();
  const allocationsQuery = useBoxAllocations(boxId);
  const allocations = allocationsQuery.data || [];
  const activeAllocations = allocations.filter((entry) => entry.status === 'ACTIVE');
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
        {allocationsQuery.isLoading ? <LoadingState label="Loading allocations..." /> : null}
        {allocationsQuery.isError ? <p className="error-text">{allocationsQuery.error.message}</p> : null}
        {!allocationsQuery.isLoading && !allocationsQuery.isError && !activeAllocations.length ? (
          <div className="empty-state">No active allocations saved for this box.</div>
        ) : null}
        {activeAllocations.length ? (
          isPhoneLayout ? (
            <div className="mobile-record-list">
              {activeAllocations.map((entry) => (
                <MobileRecordCard key={entry.allocationId}>
                  <MobileRecordHeader
                    title={formatJobLabel(entry)}
                    subtitle={`${formatClaimedFeet(entry.allocatedFeet)} claimed`}
                  />
                  <MobileFieldList>
                    <MobileField label="Job" value={renderJobValue(entry)} />
                    <MobileField label="Install Date" value={renderDate(entry.installDate)} />
                    <MobileField label="Work Scope" value={renderWorkScope(entry)} />
                    <MobileField label="LF Claimed" value={formatClaimedFeet(entry.allocatedFeet)} />
                    <MobileField label="Planning State" value={renderPlanningState(entry)} />
                  </MobileFieldList>
                </MobileRecordCard>
              ))}
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Job</th>
                    <th>Install Date</th>
                    <th>Work Scope</th>
                    <th>LF Claimed</th>
                    <th>Planning State</th>
                  </tr>
                </thead>
                <tbody>
                  {activeAllocations.map((entry) => (
                    <tr key={entry.allocationId}>
                      <td>{renderJobValue(entry)}</td>
                      <td>{renderDate(entry.installDate)}</td>
                      <td>{renderWorkScope(entry)}</td>
                      <td>{formatClaimedFeet(entry.allocatedFeet)}</td>
                      <td>{renderPlanningState(entry)}</td>
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
