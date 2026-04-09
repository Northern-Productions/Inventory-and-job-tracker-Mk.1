import { Button } from '../../../../components/Button';
import {
  MobileField,
  MobileFieldList,
  MobileRecordCard,
  MobileRecordHeader
} from '../../../../components/MobileRecordCard';
import type { AllocationJobDetailEntry, JobFilmTransferAlert } from '../../../../domain';
import { formatAllocationFeet, formatFilmTransferStateLabel, renderDateTime } from './helpers';

interface AllocatedBoxesSectionProps {
  entries: AllocationJobDetailEntry[];
  isPhoneLayout: boolean;
  isReadOnlyJob: boolean;
  canOpenAllocateDialog: boolean;
  isAuthenticated: boolean;
  clientIdConfigured: boolean;
  isStatusMutationPending: boolean;
  filmTransferAlertsByBoxId: Partial<Record<string, JobFilmTransferAlert>>;
  onOpenAllocateDialog: () => void;
  onOpenBox: (boxId: string) => void;
  onOpenFilmCheckin: (entry: AllocationJobDetailEntry) => void;
  onCheckoutAllocation: (entry: AllocationJobDetailEntry) => void;
  onRemoveAllocation: (entry: AllocationJobDetailEntry) => void;
  isAllocationRemovalPending: (allocationId: string) => boolean;
}

function renderAllocationActions({
  entry,
  isReadOnlyJob,
  isStatusMutationPending,
  transferAlert,
  onOpenFilmCheckin,
  onCheckoutAllocation,
  onRemoveAllocation,
  isAllocationRemovalPending
}: {
  entry: AllocationJobDetailEntry;
  isReadOnlyJob: boolean;
  isStatusMutationPending: boolean;
  transferAlert?: JobFilmTransferAlert;
  onOpenFilmCheckin: (entry: AllocationJobDetailEntry) => void;
  onCheckoutAllocation: (entry: AllocationJobDetailEntry) => void;
  onRemoveAllocation: (entry: AllocationJobDetailEntry) => void;
  isAllocationRemovalPending: (allocationId: string) => boolean;
}) {
  if (isReadOnlyJob) {
    return <span className="muted-text">Read-only</span>;
  }

  return (
    <div className="film-order-actions">
      {entry.checkedOutOnThisJob && entry.boxStatus === 'CHECKED_OUT' ? (
        <Button
          type="button"
          variant="secondary"
          onClick={() => onOpenFilmCheckin(entry)}
          disabled={isStatusMutationPending}
        >
          Check In
        </Button>
      ) : transferAlert ? (
        <span className="muted-text">{formatFilmTransferStateLabel(transferAlert)}</span>
      ) : entry.boxStatus === 'IN_STOCK' ? (
        <Button
          type="button"
          variant="secondary"
          onClick={() => onCheckoutAllocation(entry)}
          disabled={isStatusMutationPending}
        >
          Check Out
        </Button>
      ) : (
        <span className="muted-text">Not in stock</span>
      )}
      {!entry.checkedOutOnThisJob ? (
        <Button
          type="button"
          variant="danger"
          onClick={() => onRemoveAllocation(entry)}
          disabled={isAllocationRemovalPending(entry.allocationId) || isStatusMutationPending}
        >
          Remove
        </Button>
      ) : null}
    </div>
  );
}

export function AllocatedBoxesSection({
  entries,
  isPhoneLayout,
  isReadOnlyJob,
  canOpenAllocateDialog,
  isAuthenticated,
  clientIdConfigured,
  isStatusMutationPending,
  filmTransferAlertsByBoxId,
  onOpenAllocateDialog,
  onOpenBox,
  onOpenFilmCheckin,
  onCheckoutAllocation,
  onRemoveAllocation,
  isAllocationRemovalPending
}: AllocatedBoxesSectionProps) {
  return (
    <section className="panel">
      <div className="panel-title-row">
        <h2>Allocated Boxes</h2>
        <div className="detail-actions allocation-header-actions">
          {!isReadOnlyJob ? (
            <Button
              type="button"
              onClick={onOpenAllocateDialog}
              disabled={!canOpenAllocateDialog || !isAuthenticated || !clientIdConfigured}
            >
              Allocate Film
            </Button>
          ) : null}
        </div>
      </div>
      {!entries.length ? (
        <div className="empty-state">No allocations are tied to this job yet.</div>
      ) : isPhoneLayout ? (
        <div className="mobile-record-list">
          {entries.map((entry) => {
            const transferAlert = filmTransferAlertsByBoxId[entry.boxId];
            return (
              <MobileRecordCard key={entry.allocationId}>
                <MobileRecordHeader
                  title={entry.boxId}
                  subtitle={`${entry.manufacturer} ${entry.filmName}`}
                  onTitleClick={() => onOpenBox(entry.boxId)}
                />
                <MobileFieldList>
                  <MobileField label="Width" value={entry.widthIn || '--'} />
                  <MobileField
                    label="Allocated LF"
                    value={formatAllocationFeet(entry.allocatedFeet, entry.coveredFeet, entry.allocationKind)}
                  />
                  <MobileField label="Created" value={renderDateTime(entry.createdAt)} />
                  <MobileField label="Resolved" value={renderDateTime(entry.resolvedAt)} />
                </MobileFieldList>
                {renderAllocationActions({
                  entry,
                  isReadOnlyJob,
                  isStatusMutationPending,
                  transferAlert,
                  onOpenFilmCheckin,
                  onCheckoutAllocation,
                  onRemoveAllocation,
                  isAllocationRemovalPending
                })}
              </MobileRecordCard>
            );
          })}
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Box</th>
                <th>Film</th>
                <th>Width</th>
                <th>LF</th>
                <th>Created</th>
                <th>Resolved</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const transferAlert = filmTransferAlertsByBoxId[entry.boxId];
                return (
                  <tr key={entry.allocationId}>
                    <td>
                      <button
                        type="button"
                        className="row-button"
                        onClick={() => onOpenBox(entry.boxId)}
                      >
                        {entry.boxId}
                      </button>
                    </td>
                    <td>
                      {entry.manufacturer} {entry.filmName}
                    </td>
                    <td>{entry.widthIn || '--'}</td>
                    <td>{formatAllocationFeet(entry.allocatedFeet, entry.coveredFeet, entry.allocationKind)}</td>
                    <td>{renderDateTime(entry.createdAt)}</td>
                    <td>{renderDateTime(entry.resolvedAt)}</td>
                    <td>
                      {renderAllocationActions({
                        entry,
                        isReadOnlyJob,
                        isStatusMutationPending,
                        transferAlert,
                        onOpenFilmCheckin,
                        onCheckoutAllocation,
                        onRemoveAllocation,
                        isAllocationRemovalPending
                      })}
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
