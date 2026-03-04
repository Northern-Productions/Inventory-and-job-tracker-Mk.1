import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../../../components/Button';
import { Input } from '../../../components/Input';
import { LoadingState } from '../../../components/LoadingState';
import { formatDateTime } from '../../../lib/date';
import { useAuditList } from '../hooks/useInventoryQueries';

export default function ActivityPage() {
  const navigate = useNavigate();
  const [filters, setFilters] = useState({
    from: '',
    to: '',
    user: '',
    action: ''
  });
  const activityQuery = useAuditList(filters);

  const updateField = (key: keyof typeof filters, value: string) => {
    setFilters((current) => ({
      ...current,
      [key]: value
    }));
  };

  return (
    <>
      <section className="panel">
        <div className="panel-title-row">
          <div>
            <h2>Activity</h2>
            <p className="muted-text">Audit log across all inventory mutations.</p>
          </div>
          <Button type="button" variant="ghost" onClick={() => activityQuery.refetch()}>
            Refresh
          </Button>
        </div>
        <div className="filters-grid">
          <Input
            label="From"
            type="date"
            value={filters.from}
            onChange={(event) => updateField('from', event.target.value)}
          />
          <Input
            label="To"
            type="date"
            value={filters.to}
            onChange={(event) => updateField('to', event.target.value)}
          />
          <Input
            label="User"
            value={filters.user}
            onChange={(event) => updateField('user', event.target.value)}
            placeholder="Filter by user"
          />
          <Input
            label="Action"
            value={filters.action}
            onChange={(event) => updateField('action', event.target.value)}
            placeholder="ADD_BOX, UPDATE_BOX..."
          />
        </div>
      </section>

      <section className="panel">
        {activityQuery.isLoading ? <LoadingState label="Loading activity…" /> : null}
        {activityQuery.isError ? <p className="error-text">{activityQuery.error.message}</p> : null}
        {activityQuery.data?.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Action</th>
                  <th>BoxID</th>
                  <th>User</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {activityQuery.data.map((entry) => (
                  <tr key={entry.logId}>
                    <td>{formatDateTime(entry.date)}</td>
                    <td>{entry.action}</td>
                    <td>
                      <button
                        type="button"
                        className="row-button"
                        onClick={() => navigate(`/inventory/${encodeURIComponent(entry.boxId)}`)}
                      >
                        {entry.boxId}
                      </button>
                    </td>
                    <td>{entry.user || '—'}</td>
                    <td>{entry.notes || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {!activityQuery.isLoading && !activityQuery.data?.length ? (
          <div className="empty-state">No audit entries matched the current filters.</div>
        ) : null}
      </section>
    </>
  );
}
