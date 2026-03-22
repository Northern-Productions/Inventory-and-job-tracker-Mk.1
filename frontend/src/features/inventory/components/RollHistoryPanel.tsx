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

function renderWeight(value: number | null): string {
  return value === null ? '--' : String(value);
}

export function RollHistoryPanel({
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
  const panelBodyId = `roll-history-panel-body-${boxId}`;

  return (
    <section className={`panel ${collapsed ? 'panel-collapsed' : ''}`.trim()}>
      <div className="panel-title-row">
        <h2>Roll Weight History</h2>
        {onToggle ? (
          <button
            type="button"
            className="panel-header-toggle"
            onClick={onToggle}
            aria-expanded={!collapsed}
            aria-controls={panelBodyId}
            aria-label={`${collapsed ? 'Expand' : 'Collapse'} roll weight history`}
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
        {historyQuery.isLoading ? <LoadingState label="Loading roll history..." /> : null}
        {historyQuery.isError ? <p className="error-text">{historyQuery.error.message}</p> : null}
        {!historyQuery.isLoading && !historyQuery.isError && !historyQuery.data?.length ? (
          <div className="empty-state">No roll check-in history yet.</div>
        ) : null}
        {historyQuery.data?.length ? (
          isPhoneLayout ? (
            <div className="mobile-record-list">
              {historyQuery.data.map((entry) => (
                <MobileRecordCard key={entry.logId}>
                  <MobileRecordHeader title={entry.jobNumber || '--'} subtitle={formatDateTime(entry.checkedInAt)} />
                  <MobileFieldList>
                    <MobileField label="Date Out" value={formatDateTime(entry.checkedOutAt)} />
                    <MobileField label="Date In" value={formatDateTime(entry.checkedInAt)} />
                    <MobileField label="Out Wt" value={renderWeight(entry.checkedOutWeightLbs)} />
                    <MobileField label="In Wt" value={renderWeight(entry.checkedInWeightLbs)} />
                    <MobileField label="Delta" value={renderWeight(entry.weightDeltaLbs)} />
                    <MobileField label="Feet Before" value={entry.feetBefore} />
                    <MobileField label="Feet After" value={entry.feetAfter} />
                  </MobileFieldList>
                </MobileRecordCard>
              ))}
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Date Out</th>
                    <th>Date In</th>
                    <th>Job</th>
                    <th>Out Wt</th>
                    <th>In Wt</th>
                    <th>Delta</th>
                    <th>Feet Before</th>
                    <th>Feet After</th>
                  </tr>
                </thead>
                <tbody>
                  {historyQuery.data.map((entry) => (
                    <tr key={entry.logId}>
                      <td>{formatDateTime(entry.checkedOutAt)}</td>
                      <td>{formatDateTime(entry.checkedInAt)}</td>
                      <td>{entry.jobNumber || '--'}</td>
                      <td>{renderWeight(entry.checkedOutWeightLbs)}</td>
                      <td>{renderWeight(entry.checkedInWeightLbs)}</td>
                      <td>{renderWeight(entry.weightDeltaLbs)}</td>
                      <td>{entry.feetBefore}</td>
                      <td>{entry.feetAfter}</td>
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
