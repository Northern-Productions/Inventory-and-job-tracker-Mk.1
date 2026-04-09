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
import { formatBadgeLabel } from './helpers';

interface CaulkAllocationsSectionProps {
  entries: CaulkJobAllocationEntry[];
  isPhoneLayout: boolean;
  isReadOnlyJob: boolean;
  canOpenAllocateDialog: boolean;
  isAuthenticated: boolean;
  clientIdConfigured: boolean;
  pendingCaulkMutation: boolean;
  openCaulkCheckoutByAllocationId: Record<string, CaulkJobCheckoutEntry>;
  productsErrorMessage: string;
  onOpenAllocateDialog: () => void;
  onOpenEdit: (entry: CaulkJobAllocationEntry) => void;
  onOpenCheckout: (entry: CaulkJobAllocationEntry) => void;
  onOpenCheckin: (entry: CaulkJobCheckoutEntry) => void;
  onRemove: (entry: CaulkJobAllocationEntry) => void;
}

function renderCaulkAllocationActions({
  entry,
  openCheckoutEntry,
  isReadOnlyJob,
  pendingCaulkMutation,
  onOpenEdit,
  onOpenCheckout,
  onOpenCheckin,
  onRemove
}: {
  entry: CaulkJobAllocationEntry;
  openCheckoutEntry?: CaulkJobCheckoutEntry;
  isReadOnlyJob: boolean;
  pendingCaulkMutation: boolean;
  onOpenEdit: (entry: CaulkJobAllocationEntry) => void;
  onOpenCheckout: (entry: CaulkJobAllocationEntry) => void;
  onOpenCheckin: (entry: CaulkJobCheckoutEntry) => void;
  onRemove: (entry: CaulkJobAllocationEntry) => void;
}) {
  const hasOpenCheckout = Boolean(openCheckoutEntry);

  if (isReadOnlyJob) {
    return <span className="muted-text">Read-only</span>;
  }

  if (entry.status !== 'ACTIVE') {
    return <span className="muted-text">Cancelled</span>;
  }

  return (
    <div className="film-order-actions">
      <Button
        type="button"
        variant="secondary"
        onClick={() => onOpenEdit(entry)}
        disabled={pendingCaulkMutation || hasOpenCheckout}
      >
        Edit
      </Button>
      <Button
        type="button"
        variant="secondary"
        onClick={() =>
          hasOpenCheckout && openCheckoutEntry ? onOpenCheckin(openCheckoutEntry) : onOpenCheckout(entry)
        }
        disabled={pendingCaulkMutation}
      >
        {hasOpenCheckout ? 'Check In' : 'Check Out'}
      </Button>
      <Button
        type="button"
        variant="danger"
        onClick={() => onRemove(entry)}
        disabled={pendingCaulkMutation || hasOpenCheckout}
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
  canOpenAllocateDialog,
  isAuthenticated,
  clientIdConfigured,
  pendingCaulkMutation,
  openCaulkCheckoutByAllocationId,
  productsErrorMessage,
  onOpenAllocateDialog,
  onOpenEdit,
  onOpenCheckout,
  onOpenCheckin,
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
              disabled={!canOpenAllocateDialog || !isAuthenticated || !clientIdConfigured || pendingCaulkMutation}
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
                </MobileFieldList>
                {renderCaulkAllocationActions({
                  entry,
                  openCheckoutEntry,
                  isReadOnlyJob,
                  pendingCaulkMutation,
                  onOpenEdit,
                  onOpenCheckout,
                  onOpenCheckin,
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
                    </td>
                    <td>
                      {renderCaulkAllocationActions({
                        entry,
                        openCheckoutEntry,
                        isReadOnlyJob,
                        pendingCaulkMutation,
                        onOpenEdit,
                        onOpenCheckout,
                        onOpenCheckin,
                        onRemove
                      })}
                      {!isReadOnlyJob && entry.status === 'ACTIVE' && hasCheckoutStarted ? (
                        <span className="muted-text">Locked after checkout</span>
                      ) : null}
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
