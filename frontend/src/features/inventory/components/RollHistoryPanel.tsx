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

export function RollHistoryPanel({ boxId }: { boxId: string }) {
  const isPhoneLayout = useIsPhoneLayout();
  const historyQuery = useRollHistory(boxId);

  return (
    <section className="panel">
      <div className="panel-title-row">
        <h2>Roll Weight History</h2>
        <span className="muted-text">{boxId}</span>
      </div>
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
    </section>
  );
}
