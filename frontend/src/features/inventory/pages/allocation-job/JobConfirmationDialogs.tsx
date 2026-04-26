import { FilmCheckinDialog } from '../../components/FilmCheckinDialog';
import { ConfirmDialog } from '../../../../components/ConfirmDialog';
import { DeleteConfirmDialog } from '../../../../components/DeleteConfirmDialog';
import type {
  AllocationJobDetailEntry,
  Box,
  CaulkJobAllocationEntry,
  FilmOrderEntry
} from '../../../../domain';
import { buildCaulkProductLabel } from '../../utils/caulkProductLabels';
import type { FilmCheckinDraft } from '../../utils/boxHelpers';

interface JobConfirmationDialogsProps {
  jobNumber: string;
  isDeleteJobConfirmOpen: boolean;
  deleteJobPending: boolean;
  onCancelDeleteJob: () => void;
  onConfirmDeleteJob: () => void;
  filmOrderToDelete: FilmOrderEntry | null;
  onCancelDeleteFilmOrder: () => void;
  onConfirmDeleteFilmOrder: (order: FilmOrderEntry, reason: string) => void;
  staleFilmOrderPromptOrders: FilmOrderEntry[];
  onKeepStaleFilmOrders: () => void;
  onConfirmCancelStaleFilmOrders: () => void;
  isOrderAllConfirmOpen: boolean;
  orderableFilmRequirementCount: number;
  onCancelOrderAll: () => void;
  onConfirmOrderAll: () => void;
  allocationToRemove: AllocationJobDetailEntry | null;
  onCancelRemoveAllocation: () => void;
  onConfirmRemoveAllocation: (entry: AllocationJobDetailEntry, reason: string) => void;
  filmCheckinEntry: AllocationJobDetailEntry | null;
  filmCheckinBox: Box | null | undefined;
  filmCheckinInitialDraft?: FilmCheckinDraft | null;
  filmCheckinBoxLoading: boolean;
  filmCheckinBoxError: string;
  filmCheckinPending: boolean;
  filmCheckinReleaseJobNumber?: string;
  onCancelFilmCheckin: () => void;
  onConfirmFilmCheckin: (draft: FilmCheckinDraft) => void;
  caulkAllocationToRemove: CaulkJobAllocationEntry | null;
  onCancelRemoveCaulkAllocation: () => void;
  onConfirmRemoveCaulkAllocation: (entry: CaulkJobAllocationEntry, reason: string) => void;
  isCompleteConfirmOpen: boolean;
  onCancelCompleteJob: () => void;
  onConfirmCompleteJob: (reason: string) => void;
  isReturnCompletePromptOpen: boolean;
  onCancelReturnCompletePrompt: () => void;
  onConfirmReturnCompletePrompt: () => void;
  isReopenConfirmOpen: boolean;
  onCancelReopenJob: () => void;
  onConfirmReopenJob: (reason: string) => void;
}

export function JobConfirmationDialogs({
  jobNumber,
  isDeleteJobConfirmOpen,
  deleteJobPending,
  onCancelDeleteJob,
  onConfirmDeleteJob,
  filmOrderToDelete,
  onCancelDeleteFilmOrder,
  onConfirmDeleteFilmOrder,
  staleFilmOrderPromptOrders,
  onKeepStaleFilmOrders,
  onConfirmCancelStaleFilmOrders,
  isOrderAllConfirmOpen,
  orderableFilmRequirementCount,
  onCancelOrderAll,
  onConfirmOrderAll,
  allocationToRemove,
  onCancelRemoveAllocation,
  onConfirmRemoveAllocation,
  filmCheckinEntry,
  filmCheckinBox,
  filmCheckinInitialDraft = null,
  filmCheckinBoxLoading,
  filmCheckinBoxError,
  filmCheckinPending,
  filmCheckinReleaseJobNumber,
  onCancelFilmCheckin,
  onConfirmFilmCheckin,
  caulkAllocationToRemove,
  onCancelRemoveCaulkAllocation,
  onConfirmRemoveCaulkAllocation,
  isCompleteConfirmOpen,
  onCancelCompleteJob,
  onConfirmCompleteJob,
  isReturnCompletePromptOpen,
  onCancelReturnCompletePrompt,
  onConfirmReturnCompletePrompt,
  isReopenConfirmOpen,
  onCancelReopenJob,
  onConfirmReopenJob
}: JobConfirmationDialogsProps) {
  const staleFilmOrderPromptMessage =
    staleFilmOrderPromptOrders.length === 1
      ? `Job requirements are fulfilled. Do you want to cancel the active film order on this job for ${staleFilmOrderPromptOrders[0].filmName}?`
      : staleFilmOrderPromptOrders.length > 1
        ? `Job requirements are fulfilled. Do you want to cancel these active film orders on this job? ${staleFilmOrderPromptOrders
            .map((order) => `${order.filmOrderId}: ${order.filmName}`)
            .join('; ')}`
        : '';

  return (
    <>
      <DeleteConfirmDialog
        open={isDeleteJobConfirmOpen}
        title="Delete Job"
        message={`Delete job ${jobNumber}? This action cannot be undone. Unchecked-out film allocations and reserved caulk will be returned to stock, old job-linked allocations and usage history will be removed, film orders will be deleted, and any checked-out material must be accounted for first.`}
        cancelLabel="Keep Job"
        pending={deleteJobPending}
        onCancel={onCancelDeleteJob}
        onConfirm={onConfirmDeleteJob}
      />

      <ConfirmDialog
        open={Boolean(filmOrderToDelete)}
        title="Cancel Film Order"
        message={
          filmOrderToDelete
            ? `Cancel film order ${filmOrderToDelete.filmOrderId}? Any active allocations tied to this film order will be released back to inventory.`
            : ''
        }
        confirmLabel="Cancel Order"
        cancelLabel="Keep Film Order"
        onCancel={onCancelDeleteFilmOrder}
        onConfirm={(reason) => {
          if (!filmOrderToDelete) {
            return;
          }

          onConfirmDeleteFilmOrder(filmOrderToDelete, reason);
        }}
      />

      <ConfirmDialog
        open={staleFilmOrderPromptOrders.length > 0}
        title={
          staleFilmOrderPromptOrders.length > 1
            ? 'Cancel Fulfilled Film Orders'
            : 'Cancel Fulfilled Film Order'
        }
        message={staleFilmOrderPromptMessage}
        confirmLabel={
          staleFilmOrderPromptOrders.length > 1 ? 'Cancel Film Orders' : 'Cancel Film Order'
        }
        cancelLabel={
          staleFilmOrderPromptOrders.length > 1 ? 'Keep Film Orders' : 'Keep Film Order'
        }
        onCancel={onKeepStaleFilmOrders}
        onConfirm={onConfirmCancelStaleFilmOrders}
      />

      <ConfirmDialog
        open={isOrderAllConfirmOpen}
        title="Order All Film"
        message={`Create ${orderableFilmRequirementCount} film order${orderableFilmRequirementCount === 1 ? '' : 's'} for the unmet film requirements on job ${jobNumber}?`}
        confirmLabel="Create Orders"
        cancelLabel="Review Requirements"
        onCancel={onCancelOrderAll}
        onConfirm={onConfirmOrderAll}
      />

      <ConfirmDialog
        open={Boolean(allocationToRemove)}
        title="Remove Box Allocation"
        message={
          allocationToRemove
            ? `Remove this allocation row for box ${allocationToRemove.boxId} on job ${jobNumber}?`
            : ''
        }
        confirmLabel="Remove"
        cancelLabel="Keep Allocation"
        onCancel={onCancelRemoveAllocation}
        onConfirm={(reason) => {
          if (!allocationToRemove) {
            return;
          }

          onConfirmRemoveAllocation(allocationToRemove, reason);
        }}
      />

      <FilmCheckinDialog
        open={Boolean(filmCheckinEntry)}
        box={filmCheckinBox}
        initialDraft={filmCheckinInitialDraft}
        loading={filmCheckinBoxLoading}
        loadError={filmCheckinBoxError}
        pending={filmCheckinPending}
        releaseJobNumber={filmCheckinReleaseJobNumber}
        onCancel={onCancelFilmCheckin}
        onConfirm={onConfirmFilmCheckin}
      />

      <ConfirmDialog
        open={Boolean(caulkAllocationToRemove)}
        title="Remove Caulk Allocation"
        message={
          caulkAllocationToRemove
            ? `Remove caulk allocation ${caulkAllocationToRemove.caulkAllocationId} for ${buildCaulkProductLabel(caulkAllocationToRemove.manufacturer, caulkAllocationToRemove.productName, caulkAllocationToRemove.productCode)}?`
            : ''
        }
        confirmLabel="Remove"
        cancelLabel="Keep Allocation"
        onCancel={onCancelRemoveCaulkAllocation}
        onConfirm={(reason) => {
          if (!caulkAllocationToRemove) {
            return;
          }

          onConfirmRemoveCaulkAllocation(caulkAllocationToRemove, reason);
        }}
      />

      <ConfirmDialog
        open={isCompleteConfirmOpen}
        title="Mark Job Completed"
        message={`Mark job ${jobNumber} completed? This cancels active film allocations, active caulk allocations, and open film orders.`}
        confirmLabel="Complete Job"
        cancelLabel="Keep Open"
        onCancel={onCancelCompleteJob}
        onConfirm={onConfirmCompleteJob}
      />

      <ConfirmDialog
        open={isReturnCompletePromptOpen}
        title="Complete Job?"
        message={`All materials for job ${jobNumber} have been returned. Would you like to mark this job COMPLETE?`}
        confirmLabel="YES"
        cancelLabel="NO"
        onCancel={onCancelReturnCompletePrompt}
        onConfirm={onConfirmReturnCompletePrompt}
      />

      <ConfirmDialog
        open={isReopenConfirmOpen}
        title="Reopen Job"
        message={`Reopen job ${jobNumber}? Cancelled allocations, cancelled caulk allocations, and cancelled film orders stay cancelled.`}
        confirmLabel="Reopen Job"
        cancelLabel="Keep Closed"
        onCancel={onCancelReopenJob}
        onConfirm={onConfirmReopenJob}
      />
    </>
  );
}
