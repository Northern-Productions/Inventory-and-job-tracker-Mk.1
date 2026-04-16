import type { JobCaulkTransferAlert } from '../../../../domain';
import {
  describeCaulkTransferAlert,
  formatCaulkTransferStateLabel,
  renderDateTime
} from './helpers';

interface CaulkTransferAlertsPanelProps {
  alerts: JobCaulkTransferAlert[];
  jobWarehouse: string;
}

export function CaulkTransferAlertsPanel({
  alerts,
  jobWarehouse
}: CaulkTransferAlertsPanelProps) {
  if (!alerts.length) {
    return null;
  }

  return (
    <div className="job-transfer-alert-panel">
      <div className="panel-title-row">
        <div className="transfer-status-copy">
          <p className="eyebrow">Caulk Transfer Alerts</p>
          <h3>Cross-warehouse caulk still needs movement</h3>
          <p className="muted-text">
            Receive pending caulk into {jobWarehouse} before checking it out or marking this job
            staged for pickup.
          </p>
        </div>
      </div>
      <div className="job-transfer-alert-list">
        {alerts.map((alert) => (
          <div
            key={`${alert.caulkAllocationId}-${alert.transferId || alert.state}`}
            className="job-transfer-alert-row"
          >
            <div className="job-transfer-alert-copy">
              <strong>{`${alert.manufacturer} ${alert.productName}${alert.productCode ? ` (${alert.productCode})` : ''}`}</strong>
              <p className="muted-text">{describeCaulkTransferAlert(alert)}</p>
              {alert.state === 'TRANSFER_PENDING' && (alert.startedAt || alert.startedBy) ? (
                <p className="job-transfer-alert-meta">
                  Started {renderDateTime(alert.startedAt || '')}
                  {alert.startedBy ? ` by ${alert.startedBy}` : ''}
                </p>
              ) : null}
            </div>
            <span className="badge badge-TRANSFER">{formatCaulkTransferStateLabel(alert)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
