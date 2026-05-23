import { Button } from '../../../../components/Button';
import {
  MobileField,
  MobileFieldList,
  MobileRecordCard,
  MobileRecordHeader
} from '../../../../components/MobileRecordCard';
import type { CaulkJobAllocationEntry, CaulkJobCheckoutEntry } from '../../../../domain';
import { buildCaulkProductLabel } from '../../utils/caulkProductLabels';
import { formatCaulkTubeBreakdown } from '../../utils/caulkAllocationPlanning';
import { formatBadgeLabel, formatCaulkTransferStateLabel } from './helpers';

interface CaulkAllocationsSectionProps {
  entries: CaulkJobAllocationEntry[];
  isPhoneLayout: boolean;
  isReadOnlyJob: boolean;
  canManageTransfers: boolean;
  canOpenAllocateDialog: boolean;
  isAuthenticated: boolean;
  clientIdConfigured: boolean;
  openCaulkCheckoutByAllocationId: Record<string, CaulkJobCheckoutEntry>;
  productsErrorMessage: string;
  isWorkflowActiveAllocation?: (entry: CaulkJobAllocationEntry) => boolean;
  isCaulkAllocationPending: (caulkAllocationId: string) => boolean;
  isCaulkCheckoutPending: (caulkCheckoutId: string, caulkAllocationId?: string) => boolean;
  isCaulkTransferPending: (transferId: string) => boolean;
  onOpenAllocateDialog: () => void;
  onOpenEdit: (entry: CaulkJobAllocationEntry) => void;
  onOpenCheckout: (entry: CaulkJobAllocationEntry) => void;
  onOpenCheckin: (entry: CaulkJobCheckoutEntry) => void;
  onReceiveTransfer: (entry: CaulkJobAllocationEntry) => void;
  onCancelTransfer: (entry: CaulkJobAllocationEntry) => void;
  onRemove: (entry: CaulkJobAllocationEntry) => void;
}

function renderCaulkAllocationActions({
  entry,
  openCheckoutEntry,
  isWorkflowActive,
  isReadOnlyJob,
  canManageTransfers,
  isCaulkAllocationPending,
  isCaulkCheckoutPending,
  isCaulkTransferPending,
  onOpenEdit,
  onOpenCheckout,
  onOpenCheckin,
  onReceiveTransfer,
  onCancelTransfer,
  onRemove
}: {
  entry: CaulkJobAllocationEntry;
  openCheckoutEntry?: CaulkJobCheckoutEntry;
  isWorkflowActive: boolean;
  isReadOnlyJob: boolean;
  canManageTransfers: boolean;
  isCaulkAllocationPending: (caulkAllocationId: string) => boolean;
  isCaulkCheckoutPending: (caulkCheckoutId: string, caulkAllocationId?: string) => boolean;
  isCaulkTransferPending: (transferId: string) => boolean;
  onOpenEdit: (entry: CaulkJobAllocationEntry) => void;
  onOpenCheckout: (entry: CaulkJobAllocationEntry) => void;
  onOpenCheckin: (entry: CaulkJobCheckoutEntry) => void;
  onReceiveTransfer: (entry: CaulkJobAllocationEntry) => void;
  onCancelTransfer: (entry: CaulkJobAllocationEntry) => void;
  onRemove: (entry: CaulkJobAllocationEntry) => void;
}) {
  const hasOpenCheckout = Boolean(openCheckoutEntry);

  if (isReadOnlyJob) {
    return <span className="muted-text">Read-only</span>;
  }

  if (entry.status !== 'ACTIVE') {
    return <span className="muted-text">Cancelled</span>;
  }

  const allocationPending = isCaulkAllocationPending(entry.caulkAllocationId);
  const checkoutPending =
    openCheckoutEntry
      ? isCaulkCheckoutPending(openCheckoutEntry.caulkCheckoutId, entry.caulkAllocationId)
      : false;
  const transferPending = entry.pendingTransfer?.transferId
    ? isCaulkTransferPending(entry.pendingTransfer.transferId)
    : false;
  const outstandingTransferTubes = Math.max(
    0,
    entry.allocatedTubes - (entry.checkedOutTubesTotal + entry.reservedTubesRemaining)
  );

  if (entry.pendingTransfer) {
    return (
      <div className="film-order-actions">
        <Button
          type="button"
          variant="secondary"
          onClick={() => onReceiveTransfer(entry)}
          disabled={allocationPending || checkoutPending || transferPending || !canManageTransfers}
        >
          Receive Transfer
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={() => onCancelTransfer(entry)}
          disabled={allocationPending || checkoutPending || transferPending || !canManageTransfers}
        >
          Cancel Transfer
        </Button>
        <Button
          type="button"
          variant="danger"
          onClick={() => onRemove(entry)}
          disabled={allocationPending || checkoutPending || transferPending || hasOpenCheckout}
        >
          Remove
        </Button>
      </div>
    );
  }

  if (outstandingTransferTubes > 0) {
    return (
      <div className="film-order-actions">
        <Button
          type="button"
          variant="secondary"
          onClick={() => onOpenEdit(entry)}
          disabled={allocationPending || checkoutPending || hasOpenCheckout}
        >
          Edit
        </Button>
        <Button
          type="button"
          variant="danger"
          onClick={() => onRemove(entry)}
          disabled={allocationPending || checkoutPending || hasOpenCheckout}
        >
          Remove
        </Button>
      </div>
    );
  }

  return (
    <div className="film-order-actions">
      <Button
        type="button"
        variant="secondary"
        onClick={() => onOpenEdit(entry)}
        disabled={allocationPending || checkoutPending || hasOpenCheckout}
      >
        Edit
      </Button>
      <Button
        type="button"
        variant="secondary"
        onClick={() => {
          if (hasOpenCheckout && openCheckoutEntry) {
            onOpenCheckin(openCheckoutEntry);
          } else if (isWorkflowActive) {
            onOpenCheckout(entry);
          }
        }}
        disabled={allocationPending || checkoutPending || (!hasOpenCheckout && !isWorkflowActive)}
      >
        {hasOpenCheckout ? 'Check In' : isWorkflowActive ? 'Check Out' : 'Placeholder phase'}
      </Button>
      <Button
        type="button"
        variant="danger"
        onClick={() => onRemove(entry)}
        disabled={allocationPending || checkoutPending || hasOpenCheckout}
      >
        Remove
      </Button>
    </div>
  );
}

export function CaulkAllocationsSection({
  entries,
  isPhoneLayout,
  isReadOnlyJob,
  canManageTransfers,
  canOpenAllocateDialog,
  isAuthenticated,
  clientIdConfigured,
  openCaulkCheckoutByAllocationId,
  productsErrorMessage,
  isWorkflowActiveAllocation = () => true,
  isCaulkAllocationPending,
  isCaulkCheckoutPending,
  isCaulkTransferPending,
  onOpenAllocateDialog,
  onOpenEdit,
  onOpenCheckout,
  onOpenCheckin,
  onReceiveTransfer,
  onCancelTransfer,
  onRemove
}: CaulkAllocationsSectionProps) {
  return (
    <section className="panel">
      <div className="panel-title-row">
        <h2>Caulk Allocations</h2>
        <div className="detail-actions allocation-header-actions">
          {!isReadOnlyJob ? (
            <Button
              type="button"
              onClick={onOpenAllocateDialog}
              disabled={!canOpenAllocateDialog || !isAuthenticated || !clientIdConfigured}
            >
              Allocate Caulk
            </Button>
          ) : null}
        </div>
      </div>
      {productsErrorMessage ? <p className="error-text">{productsErrorMessage}</p> : null}
      {!entries.length ? (
        <div className="empty-state">No caulk allocations are tied to this job yet.</div>
      ) : isPhoneLayout ? (
        <div className="mobile-record-list">
          {entries.map((entry) => {
            const hasCheckoutStarted = entry.checkedOutTubesTotal > 0;
            const openCheckoutEntry = openCaulkCheckoutByAllocationId[entry.caulkAllocationId];
            const hasOpenCheckout = Boolean(openCheckoutEntry);
            const transferLabel =
              entry.pendingTransfer || entry.allocatedTubes > entry.checkedOutTubesTotal + entry.reservedTubesRemaining
                ? formatCaulkTransferStateLabel({
                    caulkAllocationId: entry.caulkAllocationId,
                    productId: entry.productId,
                    manufacturer: entry.manufacturer,
                    productName: entry.productName,
                    productCode: entry.productCode,
                    sourceWarehouse: entry.pendingTransfer?.sourceWarehouse,
                    destinationWarehouse: entry.warehouse,
                    pendingTubes: entry.pendingTransfer?.pendingTubes || Math.max(0, entry.allocatedTubes - (entry.checkedOutTubesTotal + entry.reservedTubesRemaining)),
                    state: entry.pendingTransfer ? 'TRANSFER_PENDING' : 'NEEDS_TRANSFER',
                    transferId: entry.pendingTransfer?.transferId,
                    startedAt: entry.pendingTransfer?.startedAt,
                    startedBy: entry.pendingTransfer?.startedBy
                  })
                : '';
            return (
              <MobileRecordCard key={entry.caulkAllocationId}>
                <MobileRecordHeader
                  title={buildCaulkProductLabel(entry.manufacturer, entry.productName, entry.productCode)}
                  subtitle={`Warehouse ${entry.warehouse}`}
                  badge={<span className={`badge badge-${entry.status}`}>{formatBadgeLabel(entry.status)}</span>}
                />
                <MobileFieldList>
                  <MobileField label="Allocated Tubes" value={entry.allocatedTubes} />
                  <MobileField
                    label="Allocated Breakdown"
                    value={formatCaulkTubeBreakdown(entry.allocatedTubes, entry.tubesPerCase)}
                  />
                  <MobileField label="Reserved Tubes" value={entry.reservedTubesRemaining} />
                  <MobileField label="Checked Out" value={entry.checkedOutTubesTotal} />
                  <MobileField label="Returned Unused" value={entry.returnedUnusedTubesTotal} />
                  <MobileField label="Used Tubes" value={entry.usedTubesTotal} />
                  <MobileField label="Overage Tubes" value={entry.overageTubesTotal} />
                  {transferLabel ? <MobileField label="Transfer" value={transferLabel} /> : null}
                </MobileFieldList>
                {renderCaulkAllocationActions({
                  entry,
                  openCheckoutEntry,
                  isWorkflowActive: isWorkflowActiveAllocation(entry),
                  isReadOnlyJob,
                  canManageTransfers,
                  isCaulkAllocationPending,
                  isCaulkCheckoutPending,
                  isCaulkTransferPending,
                  onOpenEdit,
                  onOpenCheckout,
                  onOpenCheckin,
                  onReceiveTransfer,
                  onCancelTransfer,
                  onRemove
                })}
                {hasCheckoutStarted ? (
                  <p className="muted-text">
                    Locked after checkout starts: product/warehouse cannot change and allocated tubes can
                    only increase.
                  </p>
                ) : null}
                {hasOpenCheckout ? (
                  <p className="muted-text">Check in open checkout cycles before another checkout.</p>
                ) : null}
                {transferLabel ? (
                  <p className="muted-text">This allocation cannot be checked out until the transfer is resolved.</p>
                ) : null}
              </MobileRecordCard>
            );
          })}
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Product</th>
                <th>Warehouse</th>
                <th>Allocated</th>
                <th>Allocated Breakdown</th>
                <th>Reserved</th>
                <th>Checked Out</th>
                <th>Returned</th>
                <th>Used</th>
                <th>Overage</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const hasCheckoutStarted = entry.checkedOutTubesTotal > 0;
                const openCheckoutEntry = openCaulkCheckoutByAllocationId[entry.caulkAllocationId];
                const outstandingTransferTubes = Math.max(
                  0,
                  entry.allocatedTubes - (entry.checkedOutTubesTotal + entry.reservedTubesRemaining)
                );
                const transferLabel =
                  entry.pendingTransfer || outstandingTransferTubes > 0
                    ? formatCaulkTransferStateLabel({
                        caulkAllocationId: entry.caulkAllocationId,
                        productId: entry.productId,
                        manufacturer: entry.manufacturer,
                        productName: entry.productName,
                        productCode: entry.productCode,
                        sourceWarehouse: entry.pendingTransfer?.sourceWarehouse,
                        destinationWarehouse: entry.warehouse,
                        pendingTubes: entry.pendingTransfer?.pendingTubes || outstandingTransferTubes,
                        state: entry.pendingTransfer ? 'TRANSFER_PENDING' : 'NEEDS_TRANSFER',
                        transferId: entry.pendingTransfer?.transferId,
                        startedAt: entry.pendingTransfer?.startedAt,
                        startedBy: entry.pendingTransfer?.startedBy
                      })
                    : '';
                return (
                  <tr key={entry.caulkAllocationId}>
                    <td>{buildCaulkProductLabel(entry.manufacturer, entry.productName, entry.productCode)}</td>
                    <td>{entry.warehouse}</td>
                    <td>{entry.allocatedTubes}</td>
                    <td>{formatCaulkTubeBreakdown(entry.allocatedTubes, entry.tubesPerCase)}</td>
                    <td>{entry.reservedTubesRemaining}</td>
                    <td>{entry.checkedOutTubesTotal}</td>
                    <td>{entry.returnedUnusedTubesTotal}</td>
                    <td>{entry.usedTubesTotal}</td>
                    <td>{entry.overageTubesTotal}</td>
                    <td>
                      <span className={`badge badge-${entry.status}`}>{formatBadgeLabel(entry.status)}</span>
                      {transferLabel ? (
                        <div className="caulk-transfer-status-inline">
                          <span className="badge badge-TRANSFER">{transferLabel}</span>
                        </div>
                      ) : null}
                    </td>
                    <td>
                      {renderCaulkAllocationActions({
                        entry,
                        openCheckoutEntry,
                        isWorkflowActive: isWorkflowActiveAllocation(entry),
                        isReadOnlyJob,
                        canManageTransfers,
                        isCaulkAllocationPending,
                        isCaulkCheckoutPending,
                        isCaulkTransferPending,
                        onOpenEdit,
                        onOpenCheckout,
                        onOpenCheckin,
                        onReceiveTransfer,
                        onCancelTransfer,
                        onRemove
                      })}
                      {!isReadOnlyJob && entry.status === 'ACTIVE' && hasCheckoutStarted ? (
                        <span className="muted-text">Locked after checkout</span>
                      ) : null}
                      {transferLabel ? <span className="muted-text">Resolve transfer before checkout.</span> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
