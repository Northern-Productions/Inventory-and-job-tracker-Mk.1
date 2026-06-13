import { type ReactNode, useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '../../../../components/Button';
import { getWarehouseLabel, type Box, type BoxTransferEntry } from '../../../../domain';
import { formatDate } from '../../../../lib/date';
import { formatJobDisplayLabel } from '../../../../lib/jobDisplay';
import { buildAllocationJobRoute } from '../../utils/jobRoutes';

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
      <dd>{value === '' || value === null || value === undefined ? '--' : value}</dd>
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

function formatBoxStatusSentence(status: string) {
  return formatBoxStatusLabel(status)
    .toLowerCase()
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatLf(value: number) {
  return `${Math.max(0, Math.floor(Number(value) || 0))} LF`;
}

function getAvailabilitySentence({
  status,
  allocatableNowFeet,
  lockedFeet,
  placeholderFeet,
  availabilityKnown
}: {
  status: string;
  allocatableNowFeet: number;
  lockedFeet: number;
  placeholderFeet: number;
  availabilityKnown: boolean;
}) {
  if (!availabilityKnown) {
    return 'Availability details are not available for this box.';
  }

  if (status === 'CHECKED_OUT' && allocatableNowFeet <= 0) {
    const reservedCopy =
      lockedFeet > 0 && placeholderFeet > 0
        ? 'scheduled or planned'
        : placeholderFeet > 0
          ? 'planned as placeholder'
          : 'scheduled';
    return `This box is checked out. All remaining film is currently ${reservedCopy}, so 0 LF is available to allocate.`;
  }

  if (allocatableNowFeet > 0) {
    return `This box has ${formatLf(allocatableNowFeet)} available to allocate.`;
  }

  if (lockedFeet > 0 && placeholderFeet > 0) {
    return `This box has ${formatLf(lockedFeet)} scheduled and ${formatLf(placeholderFeet)} planned as placeholder.`;
  }

  if (lockedFeet > 0) {
    return `This box has ${formatLf(lockedFeet)} scheduled.`;
  }

  if (placeholderFeet > 0) {
    return `This box has ${formatLf(placeholderFeet)} planned as placeholder.`;
  }

  return 'This box has no available film remaining.';
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
  deletePending: boolean;
  statusPending: boolean;
  allocationsLoading: boolean;
  currentFeetOnRoll: number | null;
  displayedAllocatedFeet: number;
  onHandAssetCost: number | null;
  isQrSectionOpen: boolean;
  qrCodeDataUrl: string;
  qrCodeError: string;
  onStartEdit: () => void;
  onSetTransferActionState: (state: 'receive' | 'cancel') => void;
  onToggleQrSection: () => void;
  onCopyQrImage: () => void;
  onDownloadQrImage: () => void;
  onCopyQrCode: () => void;
  onOpenOrderedReceiveDialog: () => void;
  allocationsSection: ReactNode;
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
  deletePending,
  statusPending,
  allocationsLoading,
  currentFeetOnRoll,
  displayedAllocatedFeet,
  onHandAssetCost,
  isQrSectionOpen,
  qrCodeDataUrl,
  qrCodeError,
  onStartEdit,
  onSetTransferActionState,
  onToggleQrSection,
  onCopyQrImage,
  onDownloadQrImage,
  onCopyQrCode,
  onOpenOrderedReceiveDialog,
  allocationsSection
}: BoxDetailHeroSectionProps) {
  const technicalDetailsId = useId();
  const originDetailsId = useId();
  const [isTechnicalDetailsOpen, setIsTechnicalDetailsOpen] = useState(false);
  const [isOriginDetailsOpen, setIsOriginDetailsOpen] = useState(false);
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
        'Pending transfers must be received or cancelled before editing this box.'
      );
    }

    return hints;
  }, [box.status, canWriteInventory, isAuthenticated, isEditing, shouldBlockEditWhileAllocationsResolve]);
  const allocatableNowFeet = Math.max(0, Number(box.allocatableNowFeet ?? box.allocationPlanningFeet ?? box.feetAvailable ?? 0));
  const physicalFeetOnHand = currentFeetOnRoll ?? box.physicalFeetAvailable ?? box.feetAvailable;
  const lockedFeet = Math.max(0, Number(box.allocatedWithInstallDateFeet ?? 0));
  const placeholderFeet = Math.max(
    0,
    Number(box.allocatedWithoutInstallDateFeet ?? Math.max(displayedAllocatedFeet - lockedFeet, 0))
  );
  const availabilityKnown = !(
    currentFeetOnRoll === null &&
    box.physicalFeetAvailable === undefined &&
    box.allocatableNowFeet === undefined &&
    box.allocationPlanningFeet === undefined
  );
  const availabilitySentence = getAvailabilitySentence({
    status: box.status,
    allocatableNowFeet,
    lockedFeet,
    placeholderFeet,
    availabilityKnown
  });
  const filmIdentityLine = [box.manufacturer, box.filmName, `${box.widthIn}"`]
    .filter((entry) => String(entry || '').trim())
    .join(' \u00b7 ');
  const warehouseStatusLine = [
    `${getWarehouseLabel(box.warehouse)} warehouse`,
    formatBoxStatusSentence(box.status)
  ]
    .filter((entry) => String(entry || '').trim())
    .join(' \u00b7 ');
  const notesText = String(box.notes || '').trim();
  const hasNotes = Boolean(notesText && notesText !== '--');
  const checkoutJobLabel = box.lastCheckoutJob
    ? formatJobDisplayLabel({
        jobNumber: box.lastCheckoutJob,
        warehouse: box.warehouse,
        workScope: box.lastCheckoutWorkScope || box.lastCheckoutSections || null
      })
    : '';
  const checkoutJobValue =
    box.lastCheckoutJobId && checkoutJobLabel ? (
      <Link to={buildAllocationJobRoute({ jobId: box.lastCheckoutJobId, jobNumber: box.lastCheckoutJob })}>
        {checkoutJobLabel}
      </Link>
    ) : (
      checkoutJobLabel || '--'
    );
  const orderedForJobs = Array.isArray(box.orderedForJobs)
    ? box.orderedForJobs.filter((entry) => entry.jobNumber || entry.filmOrderId)
    : [];

  return (
    <section className="panel detail-hero">
      <div className="panel-title-row detail-title-row">
        <div className="box-detail-title-copy">
          <p className="eyebrow">BOX DETAILS</p>
          <h2>{box.boxId}</h2>
          {filmIdentityLine ? <p className="box-detail-subtitle">{filmIdentityLine}</p> : null}
          {warehouseStatusLine ? <p className="box-detail-subtitle box-detail-subtitle-muted">{warehouseStatusLine}</p> : null}
        </div>
        <div className="box-detail-header-meta">
          <div className="box-detail-action-row">
            <span className={`badge badge-${box.status}`}>{formatBoxStatusLabel(box.status)}</span>
            {!pendingTransfer && box.status === 'ORDERED' ? (
              <Button
                type="button"
                variant="secondary"
                onClick={onOpenOrderedReceiveDialog}
                disabled={!canReceiveOrderedBox}
              >
                Receive Box
              </Button>
            ) : null}
            <Button type="button" onClick={onStartEdit} disabled={!canEditBox}>
              Edit
            </Button>
          </div>
        </div>
      </div>

      <div className="box-detail-card-grid">
        <section className="box-detail-info-card">
          <h3>Feet Summary</h3>
          <dl className="stat-grid">
            <DetailField
              label="Physical LF Remaining"
              value={currentFeetOnRoll === null && box.physicalFeetAvailable === undefined ? '...' : physicalFeetOnHand}
              labelClassName="detail-label-pill detail-label-pill-green"
            />
            <DetailField
              label="Available to Allocate"
              value={allocatableNowFeet}
              labelClassName="detail-label-pill detail-label-pill-green"
            />
            <DetailField
              label="Scheduled LF"
              value={lockedFeet}
              labelClassName="detail-label-pill detail-label-pill-orange"
            />
            <DetailField
              label="Placeholder LF"
              value={allocationsLoading ? '...' : placeholderFeet}
              labelClassName="detail-label-pill detail-label-pill-red"
            />
          </dl>
          <p className="box-detail-availability-note">{availabilitySentence}</p>
        </section>
      </div>

      <section className={`box-detail-notes-card ${hasNotes ? '' : 'box-detail-notes-card-empty'}`.trim()}>
        <h3>Notes</h3>
        <p>{hasNotes ? notesText : 'No notes recorded.'}</p>
      </section>

      <div className="box-detail-working-section">{allocationsSection}</div>

      {box.status === 'CHECKED_OUT' ? (
        <section className="box-detail-info-card box-current-activity-card">
          <h3>Current Activity</h3>
          {box.lastCheckoutJob || box.lastCheckoutDate ? (
            <dl className="detail-grid box-detail-compact-grid">
              <DetailField label="State" value="Checked out" />
              <DetailField label="Related Job" value={checkoutJobValue} />
              <DetailField label="Checked Out" value={formatDate(box.lastCheckoutDate)} />
              <DetailField
                label="Work Scope"
                value={box.lastCheckoutWorkScope || box.lastCheckoutSections || '--'}
              />
            </dl>
          ) : (
            <p className="muted-text">
              This box is currently checked out. Latest checkout details are not available.
            </p>
          )}
        </section>
      ) : null}

      <section className="box-detail-info-card">
        <h3>Dates &amp; Roll Info</h3>
        <dl className="detail-grid box-detail-compact-grid">
          <DetailField label="Date Ordered" value={formatDate(box.orderDate)} />
          <DetailField label="Date Received" value={formatDate(box.receivedDate)} />
          <DetailField label="Last Roll Weight" value={box.lastRollWeightLbs} />
          <DetailField label="Last Weighed Date" value={formatDate(box.lastWeighedDate)} />
        </dl>
      </section>

      <section className="box-technical-details-card" aria-labelledby={`${technicalDetailsId}-heading`}>
        <div className="box-technical-details-header">
          <h3 id={`${technicalDetailsId}-heading`}>Box Technical Details</h3>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="box-technical-details-toggle"
            aria-expanded={isTechnicalDetailsOpen}
            aria-controls={`${technicalDetailsId}-body`}
            aria-label={`${isTechnicalDetailsOpen ? 'Close' : 'Open'} Box Technical Details`}
            onClick={() => setIsTechnicalDetailsOpen((current) => !current)}
          >
            {isTechnicalDetailsOpen ? 'Close' : 'Open'}
          </Button>
        </div>
        <dl
          id={`${technicalDetailsId}-body`}
          className="detail-grid detail-grid-secondary box-technical-details-body"
          hidden={!isTechnicalDetailsOpen}
        >
          <DetailField label="Initial Feet" value={box.initialFeet} />
          <DetailField label="Initial Weight" value={box.initialWeightLbs} />
          <DetailField label="Core Type" value={box.coreType} />
          <DetailField label="Core Weight" value={box.coreWeightLbs} />
          <DetailField label="Lot / Run Number" value={box.lotRun} />
          <DetailField label="Purchase Cost" value={formatUsdAmount(box.purchaseCost)} />
          <DetailField label="Price / LF" value={formatPricePerLf(box.pricePerLf)} />
          <DetailField
            label="On-Hand Asset Cost"
            value={currentFeetOnRoll === null && box.physicalFeetAvailable === undefined ? '...' : formatUsdAmount(onHandAssetCost)}
          />
          <DetailField label="Zeroed Date" value={formatDate(box.zeroedDate)} />
          <DetailField label="Zeroed By" value={box.zeroedBy} />
        </dl>
      </section>

      <section className="box-technical-details-card box-origin-section" aria-labelledby={`${originDetailsId}-heading`}>
        <div className="box-technical-details-header">
          <div>
            <h3 id={`${originDetailsId}-heading`}>Origin</h3>
            <p className="muted-text box-collapsed-section-summary">
              {orderedForJobs.length ? `${orderedForJobs.length} recorded origin${orderedForJobs.length === 1 ? '' : 's'}` : 'No origin recorded'}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="box-technical-details-toggle"
            aria-expanded={isOriginDetailsOpen}
            aria-controls={`${originDetailsId}-body`}
            aria-label={`${isOriginDetailsOpen ? 'Close' : 'Open'} Origin`}
            onClick={() => setIsOriginDetailsOpen((current) => !current)}
          >
            {isOriginDetailsOpen ? 'Close' : 'Open'}
          </Button>
        </div>
        <div id={`${originDetailsId}-body`} hidden={!isOriginDetailsOpen} className="box-technical-details-body">
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
        </div>
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

      {!isEditing
        ? actionHints.map((hint) => (
            <p key={hint} className="muted-text">
              {hint}
            </p>
          ))
        : null}
    </section>
  );
}
