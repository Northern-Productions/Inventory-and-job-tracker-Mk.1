import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LoadingState } from '../../../components/LoadingState';
import type { AllocationJobStatus } from '../../../domain';
import { formatDate } from '../../../lib/date';
import { useAllocationJobs } from '../hooks/useInventoryQueries';

type LifecycleFilter = 'ACTIVE' | 'COMPLETED' | 'CANCELLED' | 'ALL';
type DueFilter = 'ALL' | 'DATED' | 'UNDATED';

function isActiveStatus(status: AllocationJobStatus) {
  return status === 'READY' || status === 'ON_ORDER' || status === 'FILM_ORDER';
}

function matchesLifecycle(status: AllocationJobStatus, filter: LifecycleFilter) {
  if (filter === 'ALL') {
    return true;
  }

  if (filter === 'ACTIVE') {
    return isActiveStatus(status);
  }

  if (filter === 'COMPLETED') {
    return status === 'COMPLETED';
  }

  return status === 'CANCELLED';
}

function matchesDue(jobDate: string, filter: DueFilter) {
  if (filter === 'ALL') {
    return true;
  }

  if (filter === 'DATED') {
    return Boolean(jobDate);
  }

  return !jobDate;
}

function formatStatusLabel(status: AllocationJobStatus) {
  return status.replace(/_/g, ' ');
}

export default function AllocationsPage() {
  const navigate = useNavigate();
  const jobsQuery = useAllocationJobs();
  const [lifecycleFilter, setLifecycleFilter] = useState<LifecycleFilter>('ACTIVE');
  const [dueFilter, setDueFilter] = useState<DueFilter>('ALL');

  const jobs = useMemo(
    () =>
      (jobsQuery.data || []).filter(
        (entry) =>
          matchesLifecycle(entry.status, lifecycleFilter) && matchesDue(entry.jobDate, dueFilter)
      ),
    [dueFilter, jobsQuery.data, lifecycleFilter]
  );

  return (
    <>
      <section className="panel">
        <div className="panel-title-row">
          <div>
            <h2>Allocations</h2>
            <p className="muted-text">
              Jobs are sorted by due date. Undated jobs stay below dated work unless you filter for them.
            </p>
          </div>
        </div>
        <div className="toolbar-grid reports-filters">
          <label className="field">
            <span className="field-label">Show</span>
            <select
              className="field-input"
              value={lifecycleFilter}
              onChange={(event) => setLifecycleFilter(event.target.value as LifecycleFilter)}
            >
              <option value="ACTIVE">Active Jobs</option>
              <option value="COMPLETED">Completed</option>
              <option value="CANCELLED">Cancelled</option>
              <option value="ALL">All</option>
            </select>
          </label>
          <label className="field">
            <span className="field-label">Due Date</span>
            <select
              className="field-input"
              value={dueFilter}
              onChange={(event) => setDueFilter(event.target.value as DueFilter)}
            >
              <option value="ALL">All</option>
              <option value="DATED">Dated Only</option>
              <option value="UNDATED">Undated Only</option>
            </select>
          </label>
        </div>
      </section>

      <section className="panel">
        <div className="panel-title-row">
          <h2>Job List</h2>
          <span className="muted-text">{jobs.length} job(s)</span>
        </div>
        {jobsQuery.isLoading ? <LoadingState label="Loading job allocations..." /> : null}
        {jobsQuery.isError ? <p className="error-text">{jobsQuery.error.message}</p> : null}
        {!jobsQuery.isLoading && !jobsQuery.isError && !jobs.length ? (
          <div className="empty-state">No jobs matched the current allocation filters.</div>
        ) : null}
        {jobs.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Job Number</th>
                  <th>Due Date</th>
                  <th>Crew Leader</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((entry) => (
                  <tr key={entry.jobNumber}>
                    <td>
                      <button
                        type="button"
                        className="row-button"
                        onClick={() =>
                          navigate(`/allocations/${encodeURIComponent(entry.jobNumber)}`)
                        }
                      >
                        {entry.jobNumber}
                      </button>
                    </td>
                    <td>{formatDate(entry.jobDate)}</td>
                    <td>{entry.crewLeader || '--'}</td>
                    <td>
                      <span className={`badge badge-${entry.status}`}>{formatStatusLabel(entry.status)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </>
  );
}
