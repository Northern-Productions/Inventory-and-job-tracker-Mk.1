import type { JobFilmTransferAlert } from '../../../../domain';
import {
  describeFilmTransferAlert,
  formatFilmTransferStateLabel,
  renderDateTime
} from './helpers';

interface FilmTransferAlertsPanelProps {
  alerts: JobFilmTransferAlert[];
  jobWarehouse: string;
  onOpenBox: (boxId: string) => void;
}

export function FilmTransferAlertsPanel({
  alerts,
  jobWarehouse,
  onOpenBox
}: FilmTransferAlertsPanelProps) {
  if (!alerts.length) {
    return null;
  }

  return (
    <div className="job-transfer-alert-panel">
      <div className="panel-title-row">
        <div className="transfer-status-copy">
          <p className="eyebrow">Film Transfer Alerts</p>
          <h3>Cross-warehouse film still needs movement</h3>
          <p className="muted-text">
            Transfer boxes to {jobWarehouse} before checking them out or marking this job staged for
            pickup.
          </p>
        </div>
      </div>
      <div className="job-transfer-alert-list">
        {alerts.map((alert) => (
          <div
            key={`${alert.boxId}-${alert.destinationWarehouse}-${alert.state}`}
            className="job-transfer-alert-row"
          >
            <div className="job-transfer-alert-copy">
              <button
                type="button"
                className="row-button job-transfer-alert-link"
                onClick={() => onOpenBox(alert.boxId)}
              >
                {alert.boxId}
              </button>
              <p className="muted-text">{describeFilmTransferAlert(alert)}</p>
              {alert.state === 'TRANSFER_PENDING' && (alert.startedAt || alert.startedBy) ? (
                <p className="job-transfer-alert-meta">
                  Started {renderDateTime(alert.startedAt || '')}
                  {alert.startedBy ? ` by ${alert.startedBy}` : ''}
                </p>
              ) : null}
            </div>
            <span className="badge badge-TRANSFER">{formatFilmTransferStateLabel(alert)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
