import { Button } from '../../../../components/Button';
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
  actionBoxId?: string;
  actionPending?: boolean;
  onStartTransfer?: (alert: JobFilmTransferAlert) => void;
  onCancelTransfer?: (alert: JobFilmTransferAlert) => void;
}

export function FilmTransferAlertsPanel({
  alerts,
  jobWarehouse,
  onOpenBox,
  actionBoxId = '',
  actionPending = false,
  onStartTransfer,
  onCancelTransfer
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
        {alerts.map((alert) => {
          const isRowPending = actionPending && actionBoxId === alert.boxId;
          const canCancel = alert.state !== 'NEEDS_TRANSFER' && Boolean(alert.transferId);

          return (
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
                {alert.state !== 'NEEDS_TRANSFER' && (alert.startedAt || alert.startedBy) ? (
                  <p className="job-transfer-alert-meta">
                    Started {renderDateTime(alert.startedAt || '')}
                    {alert.startedBy ? ` by ${alert.startedBy}` : ''}
                  </p>
                ) : null}
              </div>
              <div className="job-transfer-alert-actions">
                <span className="badge badge-TRANSFER">{formatFilmTransferStateLabel(alert)}</span>
                {canCancel ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => onCancelTransfer?.(alert)}
                    loading={isRowPending}
                    loadingLabel="Cancelling..."
                    disabled={actionPending && !isRowPending}
                  >
                    Cancel Transfer
                  </Button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
