import { useCallback, useState, type SetStateAction } from 'react';
import type { useToast } from '../../../../components/Toast';
import { formatMutationWarningDescription } from '../../../../lib/mutationWarnings';
import type {
  AllocationJobDetailEntry,
  BoxMutationResult,
  JobFilmTransferAlert,
  JobListEntry,
  RemoveJobBoxAllocationsPayload,
  RemoveJobBoxAllocationsResult,
  SetBoxStatusPayload
} from '../../../../domain';
import { useBox, usePendingSetBoxStatusBoxIds } from '../../hooks/useInventoryQueries';
import { confirmWarnings, getCheckInWarnings } from '../../utils/boxWarnings';
import {
  buildFilmCheckinPayload,
  didPersistFilmCheckinRollTracking,
  type FilmCheckinDraft
} from '../../utils/boxHelpers';
import { buildFilmTransferCheckoutMessage } from './helpers';
import {
  createFilmOrderCoverageSnapshot,
  type FilmOrderCoverageSnapshot
} from './filmOrderCoveragePrompt';

type PushToast = ReturnType<typeof useToast>['push'];
type MutationFn<Payload, Result> = (payload: Payload) => Promise<Result>;

function cloneFilmCheckinDraft(draft: FilmCheckinDraft): FilmCheckinDraft {
  return {
    ...draft
  };
}

interface UseJobFilmWorkflowArgs {
  summary: JobListEntry | undefined;
  isReadOnlyJob: boolean;
  previousHasOutstandingMaterials: boolean;
  filmTransferAlertsByBoxId: Record<string, JobFilmTransferAlert>;
  pendingRemoveJobBoxAllocationIds: Set<string>;
  canonicalJobId?: string;
  filmCoverageSnapshot?: FilmOrderCoverageSnapshot | null;
  ensureSignedIn: (actionLabel: string) => boolean;
  maybeOpenReturnCompletionPrompt: (previousHasOutstandingMaterials: boolean) => void;
  onUserDrivenFilmCoverageChange?: (
    previousSnapshot: FilmOrderCoverageSnapshot
  ) => void | Promise<void>;
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
  canonicalJobId,
  filmCoverageSnapshot,
  ensureSignedIn,
  maybeOpenReturnCompletionPrompt,
  onUserDrivenFilmCoverageChange,
  pushToast,
  removeJobBoxAllocations,
  setBoxStatus
}: UseJobFilmWorkflowArgs) {
  const [isAllocateOpen, setIsAllocateOpen] = useState(false);
  const [allocationToRemove, setAllocationToRemove] = useState<AllocationJobDetailEntry | null>(null);
  const [filmCheckinEntryState, setFilmCheckinEntryState] = useState<AllocationJobDetailEntry | null>(
    null
  );
  const [filmCheckinDraftOverride, setFilmCheckinDraftOverride] = useState<FilmCheckinDraft | null>(
    null
  );
  const pendingSetBoxStatusBoxIds = usePendingSetBoxStatusBoxIds();
  const filmCheckinBoxQuery = useBox(filmCheckinEntryState?.boxId || '');

  const setFilmCheckinEntry = useCallback(
    (nextState: SetStateAction<AllocationJobDetailEntry | null>) => {
      setFilmCheckinEntryState((current) => {
        const resolvedState =
          typeof nextState === 'function'
            ? (nextState as (value: AllocationJobDetailEntry | null) => AllocationJobDetailEntry | null)(
                current
              )
            : nextState;

        if (!resolvedState) {
          setFilmCheckinDraftOverride(null);
        }

        return resolvedState;
      });
    },
    []
  );

  const isAllocationRemovalPending = (allocationId: string) =>
    pendingRemoveJobBoxAllocationIds.has(allocationId.trim().toUpperCase());

  const isBoxStatusPending = useCallback(
    (boxId: string) => {
      const normalizedBoxId = String(boxId || '').trim().toUpperCase();
      return Boolean(normalizedBoxId) && pendingSetBoxStatusBoxIds.has(normalizedBoxId);
    },
    [pendingSetBoxStatusBoxIds]
  );

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
      const previousFilmOrderCoverageSnapshot = createFilmOrderCoverageSnapshot(filmCoverageSnapshot);
      const { result, warnings } = await removeJobBoxAllocations({
        ...(canonicalJobId ? { jobId: canonicalJobId } : {}),
        jobNumber: summary?.jobNumber || entry.jobNumber,
        allocationId: entry.allocationId,
        reason:
          reason ||
          `Removed allocation ${entry.allocationId} for box ${entry.boxId} from job ${summary?.jobNumber || entry.jobNumber}.`
      });
      pushToast({
        title: `Removed allocation ${result.allocationId}`,
        description: formatMutationWarningDescription(
          warnings,
          `Removed ${result.removedAllocationCount} allocation${result.removedAllocationCount === 1 ? '' : 's'} for box ${result.boxId}.`,
          'remove-job-box-allocation'
        ),
        variant: 'success'
      });
      await onUserDrivenFilmCoverageChange?.(previousFilmOrderCoverageSnapshot);
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
        ...(canonicalJobId ? { jobId: canonicalJobId, jobNumber: targetJobNumber } : {}),
        auditNote: `Checked out for job ${targetJobNumber}`
      });

      pushToast({
        title: `Checked out ${entry.boxId}`,
        description: formatMutationWarningDescription(
          warnings,
          `Box ${entry.boxId} was checked out for job ${targetJobNumber}.`,
          'checkout-job-box'
        ),
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

  function handleFilmCheckinConfirm(draft: FilmCheckinDraft) {
    if (!filmCheckinEntryState) {
      return;
    }

    if (!ensureSignedIn('checking in boxes')) {
      return;
    }

    const box = filmCheckinBoxQuery.data;
    if (!box) {
      pushToast({
        title: 'Box details are still loading',
        description: `The latest box record for ${filmCheckinEntryState.boxId} is not ready yet. Try again in a moment.`,
        variant: 'error'
      });
      return;
    }

    const entry = filmCheckinEntryState;
    const payload = buildFilmCheckinPayload(box, draft);
    if (canonicalJobId) {
      payload.jobId = canonicalJobId;
      payload.jobNumber = summary?.jobNumber || entry.jobNumber;
    }
    const checkInWarnings = getCheckInWarnings(box, payload.lastRollWeightLbs!, {
      currentFeetOnRoll: payload.currentFeetOnRoll,
      coreType: payload.coreType || box.coreType || undefined
    });
    if (!confirmWarnings(checkInWarnings)) {
      return;
    }

    const draftSnapshot = cloneFilmCheckinDraft(draft);
    setFilmCheckinDraftOverride(null);
    setFilmCheckinEntry(null);

    const checkinPromise = setBoxStatus(payload);
    void checkinPromise
      .then(({ result, warnings }) => {
        if (!didPersistFilmCheckinRollTracking(payload, result.box)) {
          pushToast({
            title: 'Check-in did not apply the new roll tracking values',
            description:
              'The backend responded without saving the submitted return values. Refresh the app and try again. If it persists, redeploy the latest Supabase API function and frontend build.',
            variant: 'error'
          });
          return;
        }

        pushToast({
          title: `Checked in ${entry.boxId}`,
          description: formatMutationWarningDescription(
            warnings,
            `Box ${entry.boxId} was checked in from job ${summary?.jobNumber || entry.jobNumber}.`,
            'checkin-job-box'
          ),
          variant: 'success'
        });
        maybeOpenReturnCompletionPrompt(previousHasOutstandingMaterials);
      })
      .catch((error) => {
        setFilmCheckinDraftOverride(draftSnapshot);
        setFilmCheckinEntryState(entry);
        pushToast({
          title: 'Unable to check in box',
          description: error instanceof Error ? error.message : 'The check-in request failed.',
          variant: 'error'
        });
      });
  }

  return {
    isAllocateOpen,
    openAllocateDialog,
    closeAllocateDialog,
    allocationToRemove,
    setAllocationToRemove,
    filmCheckinEntry: filmCheckinEntryState,
    filmCheckinDraftOverride,
    filmCheckinBox: filmCheckinBoxQuery.data,
    filmCheckinBoxLoading: filmCheckinBoxQuery.isLoading,
    filmCheckinBoxError:
      filmCheckinBoxQuery.isError && filmCheckinBoxQuery.error instanceof Error
        ? filmCheckinBoxQuery.error.message
        : '',
    setFilmCheckinEntry,
    isBoxStatusPending,
    isAllocationRemovalPending,
    openFilmCheckinDialog,
    handleRemoveAllocation,
    handleCheckoutAllocation,
    handleFilmCheckinConfirm
  };
}
