import { LoadingState } from '../../../components/LoadingState';
import { formatDate, formatDateTime } from '../../../lib/date';
import { useBoxAllocations } from '../hooks/useInventoryQueries';
import { getActiveAllocatedFeet } from '../utils/boxHelpers';

function renderDate(value: string): string {
  return value ? formatDate(value) : '--';
}

function renderDateTime(value: string): string {
  return value ? formatDateTime(value) : '--';
}

export function AllocationsPanel({
  boxId,
  feetAvailable
}: {
  boxId: string;
  feetAvailable: number;
}) {
  const allocationsQuery = useBoxAllocations(boxId);
  const allocations = allocationsQuery.data || [];
  const activeAllocatedFeet = getActiveAllocatedFeet(allocations);

  return (
    <section className="panel">
      <div className="panel-title-row">
        <h2>Allocations</h2>
        <span className="muted-text">{boxId}</span>
      </div>
      <div className="stat-grid allocation-stat-grid">
        <div className="key-value">
          <dt>Active Reserved LF</dt>
          <dd>{activeAllocatedFeet}</dd>
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
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Created</th>
                <th>Job</th>
                <th>Job Date</th>
                <th>Crew</th>
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
                  <td>{renderDate(entry.jobDate)}</td>
                  <td>{entry.crewLeader || '--'}</td>
                  <td>{entry.allocatedFeet}</td>
                  <td>{entry.status}</td>
                  <td>{renderDateTime(entry.resolvedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
