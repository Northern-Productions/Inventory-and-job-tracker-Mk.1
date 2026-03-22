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

export function HistoryPanel({
  boxId,
  collapsed = false,
  onToggle
}: {
  boxId: string;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const isPhoneLayout = useIsPhoneLayout();
  const historyQuery = useBoxHistory(boxId);
  const panelBodyId = `history-panel-body-${boxId}`;

  return (
    <section className={`panel ${collapsed ? 'panel-collapsed' : ''}`.trim()}>
      <div className="panel-title-row">
        <h2>History</h2>
        {onToggle ? (
          <button
            type="button"
            className="panel-header-toggle"
            onClick={onToggle}
            aria-expanded={!collapsed}
            aria-controls={panelBodyId}
            aria-label={`${collapsed ? 'Expand' : 'Collapse'} history`}
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
      </div>
    </section>
  );
}
