import { Button } from '../../../../components/Button';
import type { JobCaulkTransferAlert, JobDetail, JobFilmTransferAlert } from '../../../../domain';
import { formatJobDisplayLabel } from '../../../../lib/jobDisplay';
import { CaulkTransferAlertsPanel } from './CaulkTransferAlertsPanel';
import { FilmTransferAlertsPanel } from './FilmTransferAlertsPanel';
import { formatBadgeLabel, renderDate } from './helpers';

type JobOverviewHeroSectionProps = {
  summary: JobDetail['summary'];
  isReadOnlyJob: boolean;
  isLaborOnlyDisplayJob: boolean;
  totalRequiredCaulkTubes: number;
  totalAllocatedCaulkTubes: number;
  totalRemainingCaulkTubes: number;
  stagingBlockingMessage: string;
  canEditStagedPickup: boolean;
  canMarkStagedPickup: boolean;
  hasCheckoutableMaterials: boolean;
  filmTransferAlerts: JobFilmTransferAlert[];
  caulkTransferAlerts: JobCaulkTransferAlert[];
  isOwner: boolean;
  editPending?: boolean;
  reopenPending: boolean;
  checkoutAllPending: boolean;
  stagedPickupPending: boolean;
  statusPending: boolean;
  caulkCheckoutPending: boolean;
  filmTransferActionBoxId?: string;
  filmTransferActionPending?: boolean;
  onOpenEdit: () => void;
  onOpenReopenConfirm: () => void;
  onBack: () => void;
  onCheckoutAll: () => void;
  onToggleStagedPickup: (nextIsStaged: boolean) => void;
  onOpenTransferBox: (boxId: string) => void;
  onStartFilmTransfer?: (alert: JobFilmTransferAlert) => void;
  onCancelFilmTransfer?: (alert: JobFilmTransferAlert) => void;
};

export function JobOverviewHeroSection({
  summary,
  isReadOnlyJob,
  isLaborOnlyDisplayJob,
  totalRequiredCaulkTubes,
  totalAllocatedCaulkTubes,
  totalRemainingCaulkTubes,
  stagingBlockingMessage,
  canEditStagedPickup,
  canMarkStagedPickup,
  hasCheckoutableMaterials,
  filmTransferAlerts,
  caulkTransferAlerts,
  isOwner,
  editPending = false,
  reopenPending,
  checkoutAllPending,
  stagedPickupPending,
  statusPending,
  caulkCheckoutPending,
  filmTransferActionBoxId = '',
  filmTransferActionPending = false,
  onOpenEdit,
  onOpenReopenConfirm,
  onBack,
  onCheckoutAll,
  onToggleStagedPickup,
  onOpenTransferBox,
  onStartFilmTransfer,
  onCancelFilmTransfer
}: JobOverviewHeroSectionProps) {
  const displayJobLabel = formatJobDisplayLabel(summary);

  return (
    <section className="panel job-detail-hero">
      <div className="page-hero-topline">
        <span className="eyebrow">Job Overview</span>
        {isReadOnlyJob ? <span className="muted-text">Read-only workflow</span> : null}
      </div>
      <div className="panel-title-row">
        <div>
          <h2>JOB ID {displayJobLabel}</h2>
          <p className="muted-text">Job detail</p>
        </div>
        <div className="detail-actions">
          {summary.isLaborOnly ? (
            <span className="detail-header-pill detail-header-pill-labor-only">LABOR ONLY</span>
          ) : null}
          <span className={`badge badge-${summary.status}`}>{formatBadgeLabel(summary.status)}</span>
          {summary.hasOrderedAllocations ? (
            <span className="badge badge-ON_ORDER">ON ORDER</span>
          ) : null}
          {isReadOnlyJob ? <span className="muted-text">Read-only</span> : null}
          {!isReadOnlyJob ? (
            <Button type="button" onClick={onOpenEdit} disabled={editPending}>
              Edit
            </Button>
          ) : null}
          {isReadOnlyJob && isOwner ? (
            <Button
              type="button"
              variant="secondary"
              onClick={onOpenReopenConfirm}
              disabled={reopenPending}
            >
              Reopen Job
            </Button>
          ) : null}
          <Button type="button" variant="ghost" onClick={onBack}>
            Back
          </Button>
        </div>
      </div>
      <div className="stat-grid allocation-stat-grid">
        <div className="key-value">
          <dt>Install Date</dt>
          <dd>{renderDate(summary.installDate)}</dd>
        </div>
        <div className="key-value">
          <dt>Warehouse</dt>
          <dd>{summary.warehouse}</dd>
        </div>
        <div className="key-value">
          <dt>Work Scope</dt>
          <dd>{summary.workScope ?? summary.sections ?? '--'}</dd>
        </div>
        <div className="key-value">
          <dt>Crew Leader</dt>
          <dd>{summary.crewLeader || '--'}</dd>
        </div>
        <div className="key-value">
          <dt>Required LF</dt>
          <dd>{summary.requiredFeet}</dd>
        </div>
        <div className="key-value">
          <dt>Allocated LF</dt>
          <dd>{summary.allocatedFeet}</dd>
        </div>
        <div className="key-value">
          <dt>Remaining LF</dt>
          <dd>{summary.remainingFeet}</dd>
        </div>
        <div className="key-value">
          <dt>Required Tubes</dt>
          <dd>{totalRequiredCaulkTubes}</dd>
        </div>
        <div className="key-value">
          <dt>Allocated Tubes</dt>
          <dd>{totalAllocatedCaulkTubes}</dd>
        </div>
        <div className="key-value">
          <dt>Remaining Tubes</dt>
          <dd>{totalRemainingCaulkTubes}</dd>
        </div>
      </div>
      <div className="panel-title-row job-detail-staged-panel">
        <div className="key-value">
          <dt
            className={`detail-label-pill ${summary.isStagedForPickup ? 'detail-label-pill-green' : 'detail-label-pill-orange'}`.trim()}
          >
            Installer Pickup
          </dt>
          <dd>
            {summary.isStagedForPickup
              ? 'Staged for pickup'
              : isLaborOnlyDisplayJob
                ? 'Labor only'
                : 'Waiting on warehouse staging'}
          </dd>
          <p className="muted-text job-detail-staged-description">
            {summary.isStagedForPickup
              ? 'Installers can pick up material for this job.'
              : isLaborOnlyDisplayJob
                ? 'Labor-only jobs do not require staging or checkout. They are tracked by crew leader and install date only.'
                : stagingBlockingMessage ||
                  'Check out active phase material first, then mark the job staged for pickup.'}
          </p>
        </div>
        <div className="detail-actions job-detail-staged-actions">
          {isLaborOnlyDisplayJob ? (
            <span className="muted-text">Labor only workflow</span>
          ) : canEditStagedPickup ? (
            <div className="detail-actions job-detail-staged-actions-inner">
              <Button
                type="button"
                variant="secondary"
                onClick={onCheckoutAll}
                disabled={
                  !hasCheckoutableMaterials ||
                  checkoutAllPending ||
                  stagedPickupPending ||
                  statusPending ||
                  caulkCheckoutPending
                }
              >
                Checkout All
              </Button>
              <Button
                type="button"
                variant={summary.isStagedForPickup ? 'secondary' : 'primary'}
                onClick={() => onToggleStagedPickup(!summary.isStagedForPickup)}
                disabled={
                  checkoutAllPending ||
                  stagedPickupPending ||
                  statusPending ||
                  caulkCheckoutPending ||
                  (!summary.isStagedForPickup && !canMarkStagedPickup)
                }
                loading={stagedPickupPending}
                loadingLabel="Saving..."
              >
                {summary.isStagedForPickup ? 'Clear Staged Pickup' : 'Mark Staged for Pickup'}
              </Button>
            </div>
          ) : (
            <span className="muted-text">
              {isReadOnlyJob
                ? 'Closed jobs keep the saved pickup state for history.'
                : 'Jobs write access is required to update staged pickup.'}
            </span>
          )}
        </div>
      </div>
      <FilmTransferAlertsPanel
        alerts={filmTransferAlerts}
        jobWarehouse={summary.warehouse}
        onOpenBox={onOpenTransferBox}
        actionBoxId={filmTransferActionBoxId}
        actionPending={filmTransferActionPending}
        onStartTransfer={onStartFilmTransfer}
        onCancelTransfer={onCancelFilmTransfer}
      />
      <CaulkTransferAlertsPanel alerts={caulkTransferAlerts} jobWarehouse={summary.warehouse} />
    </section>
  );
}
