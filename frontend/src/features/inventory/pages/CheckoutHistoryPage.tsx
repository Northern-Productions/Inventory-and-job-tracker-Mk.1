import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../../../components/Button';
import { LoadingState } from '../../../components/LoadingState';
import { formatDateTime } from '../../../lib/date';
import { useAuditList } from '../hooks/useInventoryQueries';

const CHECKOUT_PREFIX = 'Checked out for job ';

function getCheckoutJobNumber(notes: string): string {
  if (!notes) {
    return '';
  }

  if (notes.startsWith(CHECKOUT_PREFIX)) {
    return notes.slice(CHECKOUT_PREFIX.length).trim();
  }

  return '';
}

export default function CheckoutHistoryPage() {
  const navigate = useNavigate();
  const checkoutQuery = useAuditList({ action: 'SET_STATUS' });

  const checkoutEntries = useMemo(
    () =>
      (checkoutQuery.data ?? []).filter((entry) => {
        const jobNumber = getCheckoutJobNumber(entry.notes);
        return Boolean(jobNumber);
      }),
    [checkoutQuery.data]
  );

  return (
    <>
      <section className="panel">
        <div className="panel-title-row">
          <div>
            <h2>Checkout History</h2>
            <p className="muted-text">All box checkouts with the attached job number, newest first.</p>
          </div>
          <Button type="button" variant="ghost" onClick={() => checkoutQuery.refetch()}>
            Refresh
          </Button>
        </div>
      </section>

      <section className="panel">
        {checkoutQuery.isLoading ? <LoadingState label="Loading checkout history…" /> : null}
        {checkoutQuery.isError ? <p className="error-text">{checkoutQuery.error.message}</p> : null}
        {checkoutEntries.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>BoxID</th>
                  <th>Job Number</th>
                  <th>User</th>
                </tr>
              </thead>
              <tbody>
                {checkoutEntries.map((entry) => (
                  <tr key={entry.logId}>
                    <td>{formatDateTime(entry.date)}</td>
                    <td>
                      <button
                        type="button"
                        className="row-button"
                        onClick={() => navigate(`/inventory/${encodeURIComponent(entry.boxId)}`)}
                      >
                        {entry.boxId}
                      </button>
                    </td>
                    <td>{getCheckoutJobNumber(entry.notes) || '—'}</td>
                    <td>{entry.user || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {!checkoutQuery.isLoading && !checkoutEntries.length ? (
          <div className="empty-state">No checkout history yet.</div>
        ) : null}
      </section>
    </>
  );
}
