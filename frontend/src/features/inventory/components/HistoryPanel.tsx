import { LoadingState } from '../../../components/LoadingState';
import {
  MobileField,
  MobileFieldList,
  MobileRecordCard,
  MobileRecordHeader
} from '../../../components/MobileRecordCard';
import { useIsPhoneLayout } from '../../../hooks/useIsPhoneLayout';
import { formatDateTime } from '../../../lib/date';
import { useBoxHistory } from '../hooks/useInventoryQueries';

export function HistoryPanel({ boxId }: { boxId: string }) {
  const isPhoneLayout = useIsPhoneLayout();
  const historyQuery = useBoxHistory(boxId);

  return (
    <section className="panel">
      <div className="panel-title-row">
        <h2>History</h2>
        <span className="muted-text">{boxId}</span>
      </div>
      {historyQuery.isLoading ? <LoadingState label="Loading history..." /> : null}
      {historyQuery.isError ? <p className="error-text">{historyQuery.error.message}</p> : null}
      {!historyQuery.isLoading && !historyQuery.isError && !historyQuery.data?.length ? (
        <div className="empty-state">No audit history yet.</div>
      ) : null}
      {historyQuery.data?.length ? (
        isPhoneLayout ? (
          <div className="mobile-record-list">
            {historyQuery.data.map((entry) => (
              <MobileRecordCard key={entry.logId}>
                <MobileRecordHeader title={entry.action} subtitle={formatDateTime(entry.date)} />
                <MobileFieldList>
                  <MobileField label="User" value={entry.user || '--'} />
                  <MobileField label="Notes" value={entry.notes || '--'} />
                </MobileFieldList>
              </MobileRecordCard>
            ))}
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Action</th>
                  <th>User</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {historyQuery.data.map((entry) => (
                  <tr key={entry.logId}>
                    <td>{formatDateTime(entry.date)}</td>
                    <td>{entry.action}</td>
                    <td>{entry.user || '--'}</td>
                    <td>{entry.notes || '--'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}
    </section>
  );
}
