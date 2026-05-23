import { type ReactNode, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../../../../components/Button';
import { getWarehouseLabel, type Box, type BoxTransferEntry } from '../../../../domain';
import { formatDate } from '../../../../lib/date';
import { formatJobDisplayLabel } from '../../../../lib/jobDisplay';

function DetailField({
  label,
  value,
  labelClassName = ''
}: {
  label: string;
  value: ReactNode;
  labelClassName?: string;
}) {
  return (
    <div className="key-value">
      <dt className={labelClassName}>{label}</dt>
      <dd>{value === '' || value === null ? '--' : value}</dd>
    </div>
  );
}

const USD_CURRENCY_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD'
});

function formatUsdAmount(value: number | null | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '--';
  }
  return USD_CURRENCY_FORMATTER.format(value);
}

function formatPricePerLf(value: number | null | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '--';
  }
  return `${USD_CURRENCY_FORMATTER.format(value)} / LF`;
}

function formatBoxStatusLabel(status: string) {
  return status === 'TRANSFER' ? 'Transfer' : status.replace(/_/g, ' ');
}

interface BoxDetailHeroSectionProps {
  box: Box;
  pendingTransfer: BoxTransferEntry | null;
  isEditing: boolean;
  isAddBoxPending: boolean;
  shouldBlockEditWhileAllocationsResolve: boolean;
  transferMutationsPending: boolean;
  isAuthenticated: boolean;
  clientIdConfigured: boolean;
  canWriteInventory: boolean;
  canWriteAllocations: boolean;
  deletePending: boolean;
  statusPending: boolean;
  allocationsLoading: boolean;
  currentFeetOnRoll: number | null;
  displayedAllocatedFeet: number;
  onHandAssetCost: number | null;
  isQrSectionOpen: boolean;
  qrCodeDataUrl: string;
  qrCodeError: string;
  onOpenTransferDialog: () => void;
  onStartEdit: () => void;
  onOpenJob: (job: { jobId?: string | null; jobNumber?: string | null }) => void;
  onSetTransferActionState: (state: 'receive' | 'cancel') => void;
  onToggleQrSection: () => void;
  onCopyQrImage: () => void;
  onDownloadQrImage: () => void;
  onCopyQrCode: () => void;
  onOpenOrderedReceiveDialog: () => void;
  onCheckIn: () => void;
  onOpenAllocateDialog: () => void;
  onCheckOut: () => void;
}

export function BoxDetailHeroSection({
  box,
  pendingTransfer,
  isEditing,
  isAddBoxPending,
  shouldBlockEditWhileAllocationsResolve,
  transferMutationsPending,
  isAuthenticated,
  clientIdConfigured,
  canWriteInventory,
  canWriteAllocations,
  deletePending,
  statusPending,
  allocationsLoading,
  currentFeetOnRoll,
  displayedAllocatedFeet,
  onHandAssetCost,
  isQrSectionOpen,
  qrCodeDataUrl,
  qrCodeError,
  onOpenTransferDialog,
  onStartEdit,
  onOpenJob,
  onSetTransferActionState,
  onToggleQrSection,
  onCopyQrImage,
  onDownloadQrImage,
  onCopyQrCode,
  onOpenOrderedReceiveDialog,
  onCheckIn,
  onOpenAllocateDialog,
  onCheckOut
}: BoxDetailHeroSectionProps) {
  const canTransferBox =
    !isEditing &&
    !pendingTransfer &&
    !isAddBoxPending &&
    !shouldBlockEditWhileAllocationsResolve &&
    !transferMutationsPending &&
    box.status === 'IN_STOCK' &&
    isAuthenticated &&
    clientIdConfigured &&
    canWriteInventory;

  const canReceiveOrderedBox =
    !isEditing &&
    !pendingTransfer &&
    !isAddBoxPending &&
    !shouldBlockEditWhileAllocationsResolve &&
    !transferMutationsPending &&
    !statusPending &&
    box.status === 'ORDERED' &&
    isAuthenticated &&
    clientIdConfigured &&
    canWriteInventory;

  const canEditBox =
    !isEditing &&
    !isAddBoxPending &&
    !deletePending &&
    !transferMutationsPending &&
    !shouldBlockEditWhileAllocationsResolve &&
    box.status !== 'TRANSFER' &&
    isAuthenticated &&
    clientIdConfigured &&
    canWriteInventory;

  const canReceiveOrCancelTransfer =
    !transferMutationsPending && isAuthenticated && clientIdConfigured && canWriteInventory;

  const actionHints = useMemo(() => {
    const hints: string[] = [];

    if (!isEditing && !isAuthenticated) {
      hints.push('Sign in with email/password before making changes.');
    }
    if (!isEditing && isAuthenticated && !canWriteInventory) {
      hints.push('You can view this box, but your role does not allow inventory edits.');
    }
    if (!isEditing && isAuthenticated && canWriteInventory && shouldBlockEditWhileAllocationsResolve) {
      hints.push("Wait for allocation data to finish loading before editing this box's current footage.");
    }
    if (!isEditing && box.status === 'TRANSFER') {
      hints.push(
        'Pending transfers must be received or cancelled before editing, allocating, checking in, or checking out this box.'
      );
    }

    return hints;
  }, [box.status, canWriteInventory, isAuthenticated, isEditing, shouldBlockEditWhileAllocationsResolve]);
  const allocatableNowFeet = box.allocatableNowFeet ?? box.allocationPlanningFeet ?? box.feetAvailable;
  const physicalFeetOnHand = currentFeetOnRoll ?? box.physicalFeetAvailable ?? box.feetAvailable;
  const lockedFeet = box.allocatedWithInstallDateFeet ?? 0;
  const placeholderFeet = box.allocatedWithoutInstallDateFeet ?? Math.max(displayedAllocatedFeet - lockedFeet, 0);
  const orderedForJobs = Array.isArray(box.orderedForJobs)
    ? box.orderedForJobs.filter((entry) => entry.jobNumber || entry.filmOrderId)
    : [];
  const lastCheckoutJobLabel = formatJobDisplayLabel({
    jobNumber: box.lastCheckoutJob,
    warehouse: box.warehouse,
    workScope: box.lastCheckoutWorkScope,
    sections: box.lastCheckoutSections
  });

  return (
    <section className="panel detail-hero">
      <p className="eyebrow">Box Details</p>
      <div className="panel-title-row detail-title-row">
        <div>
          <h2>{box.boxId}</h2>
          <p className="warehouse-pill">{getWarehouseLabel(box.warehouse)} warehouse</p>
        </div>
        <div className="detail-actions">
          <span className={`badge badge-${box.status}`}>{formatBoxStatusLabel(box.status)}</span>
          {!pendingTransfer ? (
            box.status === 'ORDERED' ? (
              <Button
                type="button"
                variant="secondary"
                onClick={onOpenOrderedReceiveDialog}
                disabled={!canReceiveOrderedBox}
              >
                Receive Box
              </Button>
            ) : (
              <Button
                type="button"
                variant="secondary"
                onClick={onOpenTransferDialog}
                disabled={!canTransferBox}
              >
                Transfer Box
              </Button>
            )
          ) : null}
          <Button type="button" onClick={onStartEdit} disabled={!canEditBox}>
            Edit
          </Button>
        </div>
      </div>

      <div className="detail-highlight-grid stat-grid">
        <div className="key-value">
          <dt className="detail-label-pill detail-label-pill-green">On Hand Feet</dt>
          <dd>{currentFeetOnRoll === null && box.physicalFeetAvailable === undefined ? '...' : physicalFeetOnHand}</dd>
        </div>
        <div className="key-value">
          <dt className="detail-label-pill detail-label-pill-green">Allocatable Now</dt>
          <dd>{allocatableNowFeet}</dd>
        </div>
        <div className="key-value">
          <dt className="detail-label-pill detail-label-pill-orange">Locked Feet</dt>
          <dd>{lockedFeet}</dd>
        </div>
        <div className="key-value">
          <dt className="detail-label-pill detail-label-pill-red">Placeholder Feet</dt>
          <dd>{allocationsLoading ? '...' : placeholderFeet}</dd>
        </div>
        <div className="key-value">
          <dt>On-Hand Asset Cost</dt>
          <dd>{currentFeetOnRoll === null && box.physicalFeetAvailable === undefined ? '...' : formatUsdAmount(onHandAssetCost)}</dd>
        </div>
      </div>

      <div className="detail-grid detail-grid-secondary">
        <DetailField label="Manufacturer" value={box.manufacturer} />
        <DetailField label="Film Name" value={box.filmName} />
        <DetailField
          label="Width"
          value={box.widthIn}
          labelClassName="detail-label-pill detail-label-pill-orange"
        />
        <DetailField label="Initial Feet" value={box.initialFeet} />
        <DetailField
          label="Current Feet"
          value={currentFeetOnRoll === null && box.physicalFeetAvailable === undefined ? '...' : physicalFeetOnHand}
        />
        <DetailField label="Lot Run" value={box.lotRun} />
        <DetailField label="Order Date" value={formatDate(box.orderDate)} />
        <DetailField label="Received Date" value={formatDate(box.receivedDate)} />
        <DetailField label="Initial Weight" value={box.initialWeightLbs} />
        <DetailField label="Last Roll Weight" value={box.lastRollWeightLbs} />
        <DetailField label="Last Weighed Date" value={formatDate(box.lastWeighedDate)} />
        <DetailField label="Core Type" value={box.coreType} />
        <DetailField label="Core Weight" value={box.coreWeightLbs} />
        <DetailField label="LF Weight / Ft" value={box.lfWeightLbsPerFt} />
        <DetailField label="Price / LF" value={formatPricePerLf(box.pricePerLf)} />
        <DetailField label="Purchase Cost" value={formatUsdAmount(box.purchaseCost)} />
        <DetailField
          label="Last Checkout Job"
          value={
            box.status === 'CHECKED_OUT' && box.lastCheckoutJob ? (
              <button
                type="button"
                className="row-button"
                onClick={() =>
                  onOpenJob({
                    jobId: box.lastCheckoutJobId,
                    jobNumber: box.lastCheckoutJob
                  })
                }
              >
                {lastCheckoutJobLabel}
              </button>
            ) : (
              lastCheckoutJobLabel
            )
          }
        />
        <DetailField label="Last Checkout Date" value={formatDate(box.lastCheckoutDate)} />
        <DetailField label="Zeroed Date" value={formatDate(box.zeroedDate)} />
        <DetailField label="Zeroed Reason" value={box.zeroedReason} />
        <DetailField label="Zeroed By" value={box.zeroedBy} />
        <DetailField label="Notes" value={box.notes} />
      </div>

      <section className="box-origin-section">
        <div className="panel-title-row">
          <h3>Origin</h3>
          <span className="muted-text">Read-only</span>
        </div>
        {orderedForJobs.length ? (
          <div className="box-origin-grid">
            {orderedForJobs.map((entry) => {
              const jobLabel = entry.jobNumber
                ? formatJobDisplayLabel({ ...entry, warehouse: box.warehouse })
                : entry.jobId
                  ? 'Open job'
                  : '--';
              const phaseLabel = entry.phaseNumber
                ? `Phase ${entry.phaseNumber}${entry.workScope ? ` - ${entry.workScope}` : ''}`
                : entry.workScope || entry.sections || '--';
              return (
                <article
                  key={`${entry.filmOrderId || 'film-order'}-${entry.jobNumber || entry.jobId || 'unknown'}-${entry.orderedFeet ?? ''}`}
                  className="box-origin-card"
                >
                  <DetailField
                    label="Job Ordered For"
                    value={
                      entry.jobId ? (
                        <Link to={`/allocations/jobs/${encodeURIComponent(entry.jobId)}`}>{jobLabel}</Link>
                      ) : (
                        jobLabel
                      )
                    }
                  />
                  <DetailField
                    label="Film Order"
                    value={
                      entry.filmOrderId ? (
                        <Link to={`/film-orders/${encodeURIComponent(entry.filmOrderId)}`}>
                          {entry.filmOrderId}
                        </Link>
                      ) : (
                        '--'
                      )
                    }
                  />
                  <DetailField label="Phase / Work Scope" value={phaseLabel} />
                  <DetailField label="Ordered Date" value={formatDate(entry.orderedDate || box.orderDate)} />
                  <DetailField label="Received Date" value={formatDate(entry.receivedDate || box.receivedDate)} />
                </article>
              );
            })}
          </div>
        ) : (
          <div className="empty-state">No origin recorded.</div>
        )}
      </section>

      {pendingTransfer ? (
        <div className="transfer-status-card">
          <div className="panel-title-row">
            <div className="transfer-status-copy">
              <p className="eyebrow">Pending Transfer</p>
              <h3>{pendingTransfer.sourceBoxId} is moving warehouses</h3>
              <p className="muted-text">
                Receive this transfer in {pendingTransfer.destinationWarehouse} before the box can be
                checked out or staged on a cross-warehouse job.
              </p>
            </div>
            <div className="detail-actions transfer-status-actions">
              <Button
                type="button"
                variant="secondary"
                onClick={() => onSetTransferActionState('receive')}
                disabled={!canReceiveOrCancelTransfer}
              >
                Receive Box
              </Button>
              <Button
                type="button"
                variant="danger"
                onClick={() => onSetTransferActionState('cancel')}
                disabled={!canReceiveOrCancelTransfer}
              >
                Cancel Transfer
              </Button>
            </div>
          </div>
          <div className="detail-grid detail-grid-secondary transfer-status-grid">
            <DetailField label="Current Warehouse" value={pendingTransfer.sourceWarehouse} />
            <DetailField label="Destination Warehouse" value={pendingTransfer.destinationWarehouse} />
            <DetailField label="Current Box ID" value={pendingTransfer.sourceBoxId} />
            <DetailField label="Received Box ID" value={pendingTransfer.destinationBoxId} />
            <DetailField label="Transfer ID" value={pendingTransfer.transferId} />
            <DetailField label="Started" value={formatDate(pendingTransfer.createdAt)} />
            <DetailField label="Started By" value={pendingTransfer.createdBy} />
            <DetailField label="Notes" value={pendingTransfer.notes} />
          </div>
        </div>
      ) : null}

      <div className={`qr-code-card ${isQrSectionOpen ? 'qr-code-card-open' : 'qr-code-card-closed'}`}>
        <button
          type="button"
          className="qr-code-toggle"
          onClick={onToggleQrSection}
          aria-expanded={isQrSectionOpen}
        >
          <span className="qr-code-toggle-label">QR Code</span>
          <span className="qr-code-toggle-symbol" aria-hidden="true">
            {isQrSectionOpen ? '-' : '+'}
          </span>
        </button>
        <div
          className={`qr-code-card-body ${isQrSectionOpen ? 'qr-code-card-body-open' : 'qr-code-card-body-closed'}`}
          aria-hidden={!isQrSectionOpen}
        >
          <div className="qr-code-preview">
            {qrCodeDataUrl ? (
              <img
                src={qrCodeDataUrl}
                alt={`QR code for box ${box.boxId}`}
                className="qr-code-image"
              />
            ) : (
              <div className="qr-code-placeholder">{qrCodeError ? 'QR unavailable' : 'Generating QR...'}</div>
            )}
          </div>
          <div className="qr-code-meta">
            <p className="muted-text">
              Copy the image for supported label software, download a PNG, or copy the raw BoxID text.
              The QR contains only the BoxID.
            </p>
            <div className="qr-code-actions">
              <Button
                type="button"
                variant="secondary"
                onClick={onCopyQrImage}
                disabled={!qrCodeDataUrl || !isQrSectionOpen}
              >
                Copy QR Image
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={onDownloadQrImage}
                disabled={!qrCodeDataUrl || !isQrSectionOpen}
              >
                Download QR PNG
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={onCopyQrCode}
                disabled={!isQrSectionOpen}
              >
                Copy QR Code
              </Button>
            </div>
            <p className="qr-code-value">{box.boxId}</p>
            {qrCodeError ? <p className="error-text">{qrCodeError}</p> : null}
          </div>
        </div>
      </div>

      {!isEditing ? (
        <>
          {actionHints.map((hint) => (
            <p key={hint} className="muted-text">
              {hint}
            </p>
          ))}

          <div className="page-actions detail-status-actions">
            <Button
              type="button"
              variant="secondary"
              onClick={onCheckIn}
              disabled={
                isAddBoxPending ||
                statusPending ||
                box.status === 'ORDERED' ||
                box.status === 'IN_STOCK' ||
                box.status === 'TRANSFER' ||
                box.status === 'ZEROED' ||
                box.status === 'RETIRED' ||
                !isAuthenticated ||
                !clientIdConfigured ||
                !canWriteInventory
              }
            >
              Check In
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={onOpenAllocateDialog}
              disabled={
                isAddBoxPending ||
                statusPending ||
                (box.status !== 'IN_STOCK' && box.status !== 'ORDERED') ||
                box.status === 'TRANSFER' ||
                !isAuthenticated ||
                !clientIdConfigured ||
                box.allocationPlanningFeet <= 0 ||
                !canWriteAllocations
              }
            >
              Allocate
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={onCheckOut}
              disabled={
                isAddBoxPending ||
                statusPending ||
                box.status === 'ORDERED' ||
                box.status === 'CHECKED_OUT' ||
                box.status === 'TRANSFER' ||
                box.status === 'ZEROED' ||
                box.status === 'RETIRED' ||
                !isAuthenticated ||
                !clientIdConfigured ||
                !canWriteInventory
              }
            >
              Check Out
            </Button>
          </div>
        </>
      ) : null}
    </section>
  );
}
