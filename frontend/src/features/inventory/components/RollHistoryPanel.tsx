import { LoadingState } from '../../../components/LoadingState';
import {
  MobileField,
  MobileFieldList,
  MobileRecordCard,
  MobileRecordHeader
} from '../../../components/MobileRecordCard';
import { useIsPhoneLayout } from '../../../hooks/useIsPhoneLayout';
import { formatDateTime } from '../../../lib/date';
import { formatJobDisplayLabel } from '../../../lib/jobDisplay';
import { useRollHistory } from '../hooks/useInventoryQueries';

function isKnownNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function renderWeight(value: number | null | undefined): string {
  return isKnownNumber(value) ? `${value} lbs` : 'Unknown';
}

function hasTrustedFeet(feetBefore: number, feetAfter: number) {
  return feetBefore > 0 || feetAfter > 0;
}

function renderFeet(value: number | null | undefined, trusted: boolean): string {
  return trusted && isKnownNumber(value) ? `${value} LF` : 'Unknown';
}

function getWeightUsed(
  checkedOutWeightLbs: number | null,
  checkedInWeightLbs: number | null,
  weightDeltaLbs: number | null
) {
  if (isKnownNumber(weightDeltaLbs)) {
    return weightDeltaLbs;
  }

  if (isKnownNumber(checkedOutWeightLbs) && isKnownNumber(checkedInWeightLbs)) {
    return Math.max(checkedOutWeightLbs - checkedInWeightLbs, 0);
  }

  return null;
}

function getLfUsed(feetBefore: number, feetAfter: number) {
  return hasTrustedFeet(feetBefore, feetAfter) ? Math.max(feetBefore - feetAfter, 0) : null;
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
                  <MobileRecordHeader
                    title={formatJobDisplayLabel(entry) || '--'}
                    subtitle={formatDateTime(entry.checkedInAt)}
                  />
                  <MobileFieldList>
                    <MobileField label="Leaving Date" value={formatDateTime(entry.checkedOutAt)} />
                    <MobileField label="Returning Date" value={formatDateTime(entry.checkedInAt)} />
                    <MobileField label="Leaving Weight" value={renderWeight(entry.checkedOutWeightLbs)} />
                    <MobileField label="Returning Weight" value={renderWeight(entry.checkedInWeightLbs)} />
                    <MobileField
                      label="Weight Used"
                      value={renderWeight(
                        getWeightUsed(
                          entry.checkedOutWeightLbs,
                          entry.checkedInWeightLbs,
                          entry.weightDeltaLbs
                        )
                      )}
                    />
                    <MobileField
                      label="Leaving LF"
                      value={renderFeet(entry.feetBefore, hasTrustedFeet(entry.feetBefore, entry.feetAfter))}
                    />
                    <MobileField
                      label="Returning LF"
                      value={renderFeet(entry.feetAfter, hasTrustedFeet(entry.feetBefore, entry.feetAfter))}
                    />
                    <MobileField label="LF Used" value={renderFeet(getLfUsed(entry.feetBefore, entry.feetAfter), true)} />
                  </MobileFieldList>
                </MobileRecordCard>
              ))}
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Leaving Date</th>
                    <th>Returning Date</th>
                    <th>Job</th>
                    <th>Leaving Weight</th>
                    <th>Returning Weight</th>
                    <th>Weight Used</th>
                    <th>Leaving LF</th>
                    <th>Returning LF</th>
                    <th>LF Used</th>
                  </tr>
                </thead>
                <tbody>
                  {historyQuery.data.map((entry) => (
                    <tr key={entry.logId}>
                      <td>{formatDateTime(entry.checkedOutAt)}</td>
                      <td>{formatDateTime(entry.checkedInAt)}</td>
                      <td>{formatJobDisplayLabel(entry) || '--'}</td>
                      <td>{renderWeight(entry.checkedOutWeightLbs)}</td>
                      <td>{renderWeight(entry.checkedInWeightLbs)}</td>
                      <td>
                        {renderWeight(
                          getWeightUsed(
                            entry.checkedOutWeightLbs,
                            entry.checkedInWeightLbs,
                            entry.weightDeltaLbs
                          )
                        )}
                      </td>
                      <td>{renderFeet(entry.feetBefore, hasTrustedFeet(entry.feetBefore, entry.feetAfter))}</td>
                      <td>{renderFeet(entry.feetAfter, hasTrustedFeet(entry.feetBefore, entry.feetAfter))}</td>
                      <td>{renderFeet(getLfUsed(entry.feetBefore, entry.feetAfter), true)}</td>
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
