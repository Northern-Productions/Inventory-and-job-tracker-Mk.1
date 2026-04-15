import { useState } from 'react';
import type { useToast } from '../../../../components/Toast';
import type {
  AllocationJobDetailEntry,
  BoxMutationResult,
  JobFilmTransferAlert,
  JobListEntry,
  RemoveJobBoxAllocationsPayload,
  RemoveJobBoxAllocationsResult,
  SetBoxStatusPayload
} from '../../../../domain';
import { useBox } from '../../hooks/useInventoryQueries';
import { confirmWarnings, getCheckInWarnings } from '../../utils/boxWarnings';
import {
  buildFilmCheckinPayload,
  didPersistFilmCheckinRollTracking,
  type FilmCheckinDraft
} from '../../utils/boxHelpers';
import { buildFilmTransferCheckoutMessage } from './helpers';

type PushToast = ReturnType<typeof useToast>['push'];
type MutationFn<Payload, Result> = (payload: Payload) => Promise<Result>;

interface UseJobFilmWorkflowArgs {
  summary: JobListEntry | undefined;
  isReadOnlyJob: boolean;
  previousHasOutstandingMaterials: boolean;
  filmTransferAlertsByBoxId: Record<string, JobFilmTransferAlert>;
  pendingRemoveJobBoxAllocationIds: Set<string>;
  ensureSignedIn: (actionLabel: string) => boolean;
  maybeOpenReturnCompletionPrompt: (previousHasOutstandingMaterials: boolean) => void;
  pushToast: PushToast;
  removeJobBoxAllocations: MutationFn<
    RemoveJobBoxAllocationsPayload,
    { result: RemoveJobBoxAllocationsResult; warnings: string[] }
  >;
  setBoxStatus: MutationFn<SetBoxStatusPayload, { result: BoxMutationResult; warnings: string[] }>;
}

export function useJobFilmWorkflow({
  summary,
  isReadOnlyJob,
  previousHasOutstandingMaterials,
  filmTransferAlertsByBoxId,
  pendingRemoveJobBoxAllocationIds,
  ensureSignedIn,
  maybeOpenReturnCompletionPrompt,
  pushToast,
  removeJobBoxAllocations,
  setBoxStatus
}: UseJobFilmWorkflowArgs) {
  const [isAllocateOpen, setIsAllocateOpen] = useState(false);
  const [allocationToRemove, setAllocationToRemove] = useState<AllocationJobDetailEntry | null>(null);
  const [filmCheckinEntry, setFilmCheckinEntry] = useState<AllocationJobDetailEntry | null>(null);
  const filmCheckinBoxQuery = useBox(filmCheckinEntry?.boxId || '');

  const isAllocationRemovalPending = (allocationId: string) =>
    pendingRemoveJobBoxAllocationIds.has(allocationId.trim().toUpperCase());

  function openAllocateDialog() {
    setIsAllocateOpen(true);
  }

  function closeAllocateDialog() {
    setIsAllocateOpen(false);
  }

  async function handleRemoveAllocation(entry: AllocationJobDetailEntry, reason: string) {
    if (isReadOnlyJob) {
      pushToast({
        title: 'Job is read-only',
        description: `Job ${entry.jobNumber} is closed and allocations cannot be removed.`,
        variant: 'error'
      });
      return;
    }

    if (entry.checkedOutOnThisJob) {
      pushToast({
        title: 'Cannot remove checked-out allocation',
        description: `Box ${entry.boxId} is currently checked out on job ${entry.jobNumber}. Check it in first.`,
        variant: 'error'
      });
      return;
    }

    if (!ensureSignedIn('removing allocations')) {
      return;
    }

    try {
      const { result, warnings } = await removeJobBoxAllocations({
        jobNumber: summary?.jobNumber || entry.jobNumber,
        allocationId: entry.allocationId,
        reason:
          reason ||
          `Removed allocation ${entry.allocationId} for box ${entry.boxId} from job ${summary?.jobNumber || entry.jobNumber}.`
      });
      pushToast({
        title: `Removed allocation ${result.allocationId}`,
        description:
          warnings.join(' ') ||
          `Removed ${result.removedAllocationCount} allocation${result.removedAllocationCount === 1 ? '' : 's'} for box ${result.boxId}.`,
        variant: 'success'
      });
    } catch (error) {
      pushToast({
        title: 'Unable to remove allocation',
        description: error instanceof Error ? error.message : 'The remove request failed.',
        variant: 'error'
      });
    }
  }

  async function handleCheckoutAllocation(entry: AllocationJobDetailEntry) {
    if (isReadOnlyJob) {
      pushToast({
        title: 'Job is read-only',
        description: `Job ${entry.jobNumber} is closed and allocations cannot be checked out.`,
        variant: 'error'
      });
      return;
    }

    if (entry.checkedOutOnThisJob) {
      return;
    }

    const transferAlert = filmTransferAlertsByBoxId[entry.boxId];
    if (transferAlert) {
      pushToast({
        title: 'Transfer required',
        description: buildFilmTransferCheckoutMessage(transferAlert),
        variant: 'error'
      });
      return;
    }

    if (entry.boxStatus !== 'IN_STOCK') {
      const detailText =
        entry.boxStatus === 'ORDERED'
          ? `Box ${entry.boxId} is still waiting for receipt and cannot be checked out yet.`
          : entry.boxStatus === 'CHECKED_OUT'
          ? `Box ${entry.boxId} is already checked out on another job.`
          : `Box ${entry.boxId} is ${entry.boxStatus || 'not in stock'} and cannot be checked out from this view.`;
      pushToast({
        title: 'Box is not actionable',
        description: detailText,
        variant: 'error'
      });
      return;
    }

    if (!ensureSignedIn('checking out boxes')) {
      return;
    }

    const targetJobNumber = summary?.jobNumber || entry.jobNumber;
    try {
      const { warnings } = await setBoxStatus({
        boxId: entry.boxId,
        status: 'CHECKED_OUT',
        auditNote: `Checked out for job ${targetJobNumber}`
      });

      pushToast({
        title: `Checked out ${entry.boxId}`,
        description:
          warnings.join(' ') || `Box ${entry.boxId} was checked out for job ${targetJobNumber}.`,
        variant: 'success'
      });
    } catch (error) {
      pushToast({
        title: 'Unable to check out box',
        description: error instanceof Error ? error.message : 'The checkout request failed.',
        variant: 'error'
      });
    }
  }

  function openFilmCheckinDialog(entry: AllocationJobDetailEntry) {
    if (isReadOnlyJob) {
      pushToast({
        title: 'Job is read-only',
        description: `Job ${entry.jobNumber} is closed and allocations cannot be checked in.`,
        variant: 'error'
      });
      return;
    }

    if (!entry.checkedOutOnThisJob || entry.boxStatus !== 'CHECKED_OUT') {
      pushToast({
        title: 'Box is not actionable',
        description: `Box ${entry.boxId} is not currently checked out on job ${entry.jobNumber}.`,
        variant: 'error'
      });
      return;
    }

    setFilmCheckinEntry(entry);
  }

  async function handleFilmCheckinConfirm(draft: FilmCheckinDraft) {
    if (!filmCheckinEntry) {
      return;
    }

    if (!ensureSignedIn('checking in boxes')) {
      return;
    }

    const box = filmCheckinBoxQuery.data;
    if (!box) {
      pushToast({
        title: 'Box details are still loading',
        description: `The latest box record for ${filmCheckinEntry.boxId} is not ready yet. Try again in a moment.`,
        variant: 'error'
      });
      return;
    }

    try {
      const entry = filmCheckinEntry;
      const payload = buildFilmCheckinPayload(box, draft);
      const checkInWarnings = getCheckInWarnings(box, payload.lastRollWeightLbs!, {
        currentFeetOnRoll: payload.currentFeetOnRoll,
        coreType: payload.coreType || box.coreType || undefined
      });
      if (!confirmWarnings(checkInWarnings)) {
        return;
      }

      const { result, warnings } = await setBoxStatus(payload);
      if (!didPersistFilmCheckinRollTracking(payload, result.box)) {
        pushToast({
          title: 'Check-in did not apply the new roll tracking values',
          description:
            'The backend responded without saving the submitted return values. Refresh the app and try again. If it persists, redeploy the latest Supabase API function and frontend build.',
          variant: 'error'
        });
        return;
      }

      setFilmCheckinEntry(null);
      pushToast({
        title: `Checked in ${entry.boxId}`,
        description:
          warnings.join(' ') ||
          `Box ${entry.boxId} was checked in from job ${summary?.jobNumber || entry.jobNumber}.`,
        variant: 'success'
      });
      maybeOpenReturnCompletionPrompt(previousHasOutstandingMaterials);
    } catch (error) {
      pushToast({
        title: 'Unable to check in box',
        description: error instanceof Error ? error.message : 'The check-in request failed.',
        variant: 'error'
      });
    }
  }

  return {
    isAllocateOpen,
    openAllocateDialog,
    closeAllocateDialog,
    allocationToRemove,
    setAllocationToRemove,
    filmCheckinEntry,
    filmCheckinBox: filmCheckinBoxQuery.data,
    filmCheckinBoxLoading: filmCheckinBoxQuery.isLoading,
    filmCheckinBoxError:
      filmCheckinBoxQuery.isError && filmCheckinBoxQuery.error instanceof Error
        ? filmCheckinBoxQuery.error.message
        : '',
    setFilmCheckinEntry,
    isAllocationRemovalPending,
    openFilmCheckinDialog,
    handleRemoveAllocation,
    handleCheckoutAllocation,
    handleFilmCheckinConfirm
  };
}
