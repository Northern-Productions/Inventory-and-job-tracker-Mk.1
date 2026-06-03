import { LoadingState } from '../../../components/LoadingState';
import {
  MobileField,
  MobileFieldList,
  MobileRecordCard,
  MobileRecordHeader
} from '../../../components/MobileRecordCard';
import { useIsPhoneLayout } from '../../../hooks/useIsPhoneLayout';
import { formatDateTime } from '../../../lib/date';
import { useRollHistory } from '../hooks/useInventoryQueries';

function hasTrustedFeet(feetBefore: number, feetAfter: number) {
  return feetBefore > 0 || feetAfter > 0;
}

function renderLfUsed(feetBefore: number, feetAfter: number): string {
  return hasTrustedFeet(feetBefore, feetAfter)
    ? `${Math.max(feetBefore - feetAfter, 0)} LF`
    : '--';
}

function renderDate(value: string): string {
  return value ? formatDateTime(value) : '--';
}

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
  const historyQuery = useRollHistory(boxId);
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
          <div className="empty-state">No usage or check-in history yet.</div>
        ) : null}
        {historyQuery.data?.length ? (
          isPhoneLayout ? (
            <div className="mobile-record-list">
              {historyQuery.data.map((entry) => (
                <MobileRecordCard key={entry.logId}>
                  <MobileRecordHeader
                    title={entry.jobNumber || '--'}
                    subtitle={renderDate(entry.checkedInAt || entry.checkedOutAt)}
                  />
                  <MobileFieldList>
                    <MobileField label="Date" value={renderDate(entry.checkedInAt || entry.checkedOutAt)} />
                    <MobileField label="Job Number" value={entry.jobNumber || '--'} />
                    <MobileField label="LF Used" value={renderLfUsed(entry.feetBefore, entry.feetAfter)} />
                    <MobileField label="Crew Leader" value="--" />
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
                    <th>Job Number</th>
                    <th>LF Used</th>
                    <th>Crew Leader</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {historyQuery.data.map((entry) => (
                    <tr key={entry.logId}>
                      <td>{renderDate(entry.checkedInAt || entry.checkedOutAt)}</td>
                      <td>{entry.jobNumber || '--'}</td>
                      <td>{renderLfUsed(entry.feetBefore, entry.feetAfter)}</td>
                      <td>--</td>
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
