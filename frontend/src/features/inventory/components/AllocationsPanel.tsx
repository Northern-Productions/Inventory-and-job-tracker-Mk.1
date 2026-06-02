import { LoadingState } from '../../../components/LoadingState';
import { Link } from 'react-router-dom';
import {
  MobileField,
  MobileFieldList,
  MobileRecordCard,
  MobileRecordHeader
} from '../../../components/MobileRecordCard';
import { useIsPhoneLayout } from '../../../hooks/useIsPhoneLayout';
import { formatDate, formatDateTime } from '../../../lib/date';
import { formatJobDisplayLabel } from '../../../lib/jobDisplay';
import { useBoxAllocations } from '../hooks/useInventoryQueries';
import { buildAllocationJobRoute } from '../utils/jobRoutes';
import type { AllocationEntry } from '../../../domain';

function renderDate(value: string): string {
  return value ? formatDate(value) : '--';
}

function renderDateTime(value: string): string {
  return value ? formatDateTime(value) : '--';
}

function formatReservedFeet(allocatedFeet: number) {
  return `${allocatedFeet} LF`;
}

function formatJobLabel(entry: AllocationEntry) {
  return formatJobDisplayLabel(entry) || '--';
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
                    subtitle={renderDateTime(entry.createdAt)}
                  />
                  <MobileFieldList>
                    <MobileField label="Created" value={renderDateTime(entry.createdAt)} />
                    <MobileField label="Job" value={renderJobValue(entry)} />
                    <MobileField label="Install Date" value={renderDate(entry.installDate)} />
                    <MobileField label="LF Reserved" value={formatReservedFeet(entry.allocatedFeet)} />
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
                    <th>LF Reserved</th>
                  </tr>
                </thead>
                <tbody>
                  {activeAllocations.map((entry) => (
                    <tr key={entry.allocationId}>
                      <td>{renderDateTime(entry.createdAt)}</td>
                      <td>{renderJobValue(entry)}</td>
                      <td>{renderDate(entry.installDate)}</td>
                      <td>{formatReservedFeet(entry.allocatedFeet)}</td>
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
