import { useEffect, useState } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import { APIError } from '../../../../api/http';
import type { useToast } from '../../../../components/Toast';
import {
  formatMutationWarningDescription,
  type MutationWarningFormatOptions
} from '../../../../lib/mutationWarnings';
import type {
  AllocationEntry,
  Box,
  BoxDealerEntry,
  BoxMutationResult,
  DeleteBoxPayload,
  DeleteBoxResult,
  ReceiveOrderedBoxPayload,
  SetBoxStatusPayload,
  UpsertBoxDealerPayload,
  UndoAuditPayload,
  UndoMutationResult,
  UpdateBoxPayload
} from '../../../../domain';
import type { BoxDraft, FilmCheckinDraft, OrderedBoxReceiveDraft } from '../../utils/boxHelpers';
import {
  buildReceiveOrderedBoxPayload,
  buildFilmCheckinPayload,
  didPersistFilmCheckinRollTracking
} from '../../utils/boxHelpers';
import {
  confirmWarnings,
  getAddOrEditWarnings,
  getCheckInWarnings,
  getCheckoutBlockReason,
  getCheckoutWarnings
} from '../../utils/boxWarnings';
import {
  buildZeroedInventoryPayloadForEdit,
  buildZeroedInventoryReactivationPayloadForEdit,
  getZeroedInventoryEditTrigger,
  getIncompleteBoxHistoryFieldsForZeroedEdit,
  shouldPromptZeroedInventoryReactivationOnEdit
} from '../../utils/boxZeroedTransition';
import { parseUpdateBoxDraft } from '../../schemas/boxSchemas';
import { createStatusConfirmState } from './helpers';
import type {
  ConfirmState,
  PendingZeroedEditState,
  PendingZeroedReactivationState
} from './types';

type PushToast = ReturnType<typeof useToast>['push'];
type UpdateMutationFn = (payload: UpdateBoxPayload) => Promise<{
  result: BoxMutationResult;
  warnings: string[];
}>;
type DeleteMutationFn = (payload: DeleteBoxPayload) => Promise<{
  result: DeleteBoxResult;
  warnings: string[];
}>;
type SetStatusMutationFn = (payload: SetBoxStatusPayload) => Promise<{
  result: BoxMutationResult;
  warnings: string[];
}>;
type ReceiveOrderedMutationFn = (payload: ReceiveOrderedBoxPayload) => Promise<{
  result: BoxMutationResult;
  warnings: string[];
}>;
type UndoMutationFn = (payload: UndoAuditPayload) => Promise<{
  result: UndoMutationResult;
  warnings: string[];
}>;
type UpsertDealerMutationFn = (payload: UpsertBoxDealerPayload) => Promise<BoxDealerEntry>;

const ORDERED_RECEIVE_PLANNER_WARNING_SUMMARY =
  'Box received with planner warnings. Some legacy reservations may need review.';

interface UseBoxDetailActionsArgs {
  box: Box | undefined;
  boxId: string;
  allocations: AllocationEntry[];
  allocationsLoading: boolean;
  allocationsError: boolean;
  dealerEntries: BoxDealerEntry[];
  checkoutJobOptions: Array<{ label: string; value: string }>;
  ensureSignedIn: (actionLabel: string, feature?: 'inventory' | 'allocations') => boolean;
  navigate: NavigateFunction;
  pushToast: PushToast;
  onEditComplete: () => void;
  updateBox: UpdateMutationFn;
  deleteBox: DeleteMutationFn;
  setBoxStatus: SetStatusMutationFn;
  receiveOrderedBox: ReceiveOrderedMutationFn;
  undoAudit: UndoMutationFn;
  upsertDealer: UpsertDealerMutationFn;
}

export function useBoxDetailActions({
  box,
  boxId,
  allocations,
  allocationsLoading,
  allocationsError,
  dealerEntries,
  checkoutJobOptions,
  ensureSignedIn,
  navigate,
  pushToast,
  onEditComplete,
  updateBox,
  deleteBox,
  setBoxStatus,
  receiveOrderedBox,
  undoAudit,
  upsertDealer
}: UseBoxDetailActionsArgs) {
  const [confirmState, setConfirmState] = useState<ConfirmState>(null);
  const [isFilmCheckinOpen, setIsFilmCheckinOpen] = useState(false);
  const [isOrderedReceiveOpen, setIsOrderedReceiveOpen] = useState(false);
  const [pendingZeroedEditState, setPendingZeroedEditState] = useState<PendingZeroedEditState | null>(null);
  const [pendingZeroedReactivationState, setPendingZeroedReactivationState] =
    useState<PendingZeroedReactivationState | null>(null);

  useEffect(() => {
    setConfirmState(null);
    setIsFilmCheckinOpen(false);
    setIsOrderedReceiveOpen(false);
    setPendingZeroedEditState(null);
    setPendingZeroedReactivationState(null);
  }, [boxId]);

  async function pushUndoToast(
    logId: string,
    title: string,
    boxIdValue: string,
    warnings: string[],
    successDescription = `${boxIdValue} was saved successfully.`,
    warningOptions: MutationWarningFormatOptions = {},
    onUndoSuccess?: (restoredBox: Box | null) => void
  ) {
    pushToast({
      title,
      description: formatMutationWarningDescription(
        warnings,
        successDescription,
        'box-detail-mutation',
        warningOptions
      ),
      actionLabel: 'Undo',
      onAction: async () => {
        try {
          const undone = await undoAudit({
            logId,
            reason: 'Undo from success toast'
          });

          pushToast({
            title: 'Undo completed',
            description: formatMutationWarningDescription(
              undone.warnings,
              `${boxIdValue} was reverted.`,
              'undo-box-mutation'
            ),
            variant: 'success'
          });
          onUndoSuccess?.(undone.result.box);
        } catch (error) {
          pushToast({
            title: 'Undo failed',
            description:
              error instanceof Error ? error.message : 'The undo request could not be completed.',
            variant: 'error'
          });
        }
      }
    });
  }

  async function handleDeleteBox() {
    if (!box) {
      return;
    }

    if (!ensureSignedIn('delete this box', 'inventory')) {
      return;
    }

    try {
      const deletePromise = deleteBox({
        boxId: box.boxId,
        reason: 'Deleted from box details.'
      });
      navigate('/', { replace: true });
      await deletePromise;
    } catch (error) {
      navigate(`/inventory/${encodeURIComponent(box.boxId)}`, { replace: true });
      pushToast({
        title: 'Delete failed',
        description:
          error instanceof APIError || error instanceof Error
            ? error.message
            : 'The box could not be deleted.',
        variant: 'error'
      });
    }
  }

  async function submitUpdate(payload: UpdateBoxPayload) {
    try {
      const { result, warnings } = await updateBox(payload);
      onEditComplete();

      const didMoveToZeroed = result.box.status === 'ZEROED';
      const wasZeroedBeforeUpdate = box?.status === 'ZEROED';
      const didTransitionToZeroed = didMoveToZeroed && !wasZeroedBeforeUpdate;
      const successTitle = didTransitionToZeroed ? 'Moved to zeroed out inventory' : 'Box updated';
      const successDescription = didTransitionToZeroed
        ? `${result.box.boxId} was moved to zeroed out inventory.`
        : undefined;

      await pushUndoToast(result.logId, successTitle, result.box.boxId, warnings, successDescription);

      if (didTransitionToZeroed) {
        navigate('/');
      }
    } catch (error) {
      pushToast({
        title: 'Update failed',
        description:
          error instanceof APIError || error instanceof Error
            ? error.message
            : 'The update could not be completed.',
        variant: 'error'
      });
    }
  }

  async function runStandardUpdateFlow(payload: UpdateBoxPayload) {
    const addOrEditWarnings = getAddOrEditWarnings(payload, box, allocations);
    if (!confirmWarnings(addOrEditWarnings)) {
      return;
    }

    await submitUpdate({
      ...payload,
      auditNote:
        payload.auditNote?.trim() ||
        (payload.moveToZeroed ? 'Confirmed zeroed inventory edit save' : 'Inventory metadata update')
    });
  }

  async function normalizeDraftDealer(draft: BoxDraft) {
    const normalizedDealer = draft.dealer.trim();
    if (!normalizedDealer) {
      return draft;
    }

    const existingEntry = dealerEntries.find(
      (entry) => entry.name.trim().toLocaleLowerCase() === normalizedDealer.toLocaleLowerCase()
    );
    if (existingEntry) {
      return existingEntry.name === draft.dealer
        ? draft
        : {
            ...draft,
            dealer: existingEntry.name
          };
    }

    const savedEntry = await upsertDealer({ name: normalizedDealer });
    return savedEntry.name === draft.dealer
      ? draft
      : {
          ...draft,
          dealer: savedEntry.name
        };
  }

  async function handleEditSubmit(draft: BoxDraft) {
    if (!ensureSignedIn('save box changes', 'inventory')) {
      return;
    }

    try {
      if (draft.receivedDate && (allocationsLoading || allocationsError)) {
        pushToast({
          title: 'Allocation data unavailable',
          description: allocationsLoading
            ? 'Wait for allocation data to finish loading, then try saving again.'
            : 'Refresh the box allocations and try saving again.',
          variant: 'error'
        });
        return;
      }

      const nextDraft = await normalizeDraftDealer(draft);
      const payload = parseUpdateBoxDraft(nextDraft, box, allocations);
      if (shouldPromptZeroedInventoryReactivationOnEdit(box, payload)) {
        setPendingZeroedReactivationState({
          payload: buildZeroedInventoryReactivationPayloadForEdit(payload)
        });
        return;
      }

      const zeroedTrigger = getZeroedInventoryEditTrigger(box, payload);

      if (zeroedTrigger) {
        setPendingZeroedEditState({
          activePayload: payload,
          zeroedPayload: buildZeroedInventoryPayloadForEdit(box, payload, zeroedTrigger),
          missingFields: getIncompleteBoxHistoryFieldsForZeroedEdit(box, payload),
          trigger: zeroedTrigger
        });
        return;
      }

      await runStandardUpdateFlow(payload);
    } catch (error) {
      pushToast({
        title: 'Validation failed',
        description:
          error instanceof Error ? error.message : 'Review the form values and try again.',
        variant: 'error'
      });
    }
  }

  async function handleStatusChange(status: SetBoxStatusPayload['status']) {
    if (!box) {
      return;
    }

    if (!ensureSignedIn('change box status', 'inventory')) {
      return;
    }

    if (status === 'CHECKED_OUT') {
      const checkoutBlockReason = getCheckoutBlockReason(box);
      if (checkoutBlockReason) {
        pushToast({
          title: 'Checkout blocked',
          description: checkoutBlockReason,
          variant: 'error'
        });
        return;
      }

      const checkoutMessage =
        checkoutJobOptions.length > 0
          ? "Select one of this box's active allocated jobs, or choose Enter New Job Number if this checkout is for something else."
          : 'Enter the job number for this checkout. It will be saved in the box history.';

      setConfirmState(createStatusConfirmState(box.boxId, status, checkoutMessage));
      return;
    }

    if (status === 'IN_STOCK' && box.status === 'ORDERED') {
      setIsOrderedReceiveOpen(true);
      return;
    }

    setIsFilmCheckinOpen(true);
  }

  function handleCancelConfirm() {
    setConfirmState(null);
  }

  function handleCancelFilmCheckin() {
    setIsFilmCheckinOpen(false);
  }

  function handleCancelOrderedReceive() {
    setIsOrderedReceiveOpen(false);
  }

  function openOrderedReceiveDialog() {
    setIsOrderedReceiveOpen(true);
  }

  async function handleConfirm(reason: string) {
    if (!confirmState) {
      return;
    }

    if (!box) {
      setConfirmState(null);
      return;
    }

    if (confirmState.type === 'checkout') {
      const warnings = getCheckoutWarnings(box);
      if (!confirmWarnings(warnings)) {
        return;
      }

      const payload = {
        ...confirmState.payload,
        auditNote: `Checked out for job ${reason}`
      };

      try {
        setConfirmState(null);
        const { result, warnings: responseWarnings } = await setBoxStatus(payload);
        await pushUndoToast(result.logId, 'Box checked out', result.box.boxId, responseWarnings);
      } catch (error) {
        pushToast({
          title: 'Status change failed',
          description:
            error instanceof Error ? error.message : 'The status update could not be completed.',
          variant: 'error'
        });
      }

      return;
    }
    void reason;
    setConfirmState(null);
  }

  async function handleFilmCheckinConfirm(draft: FilmCheckinDraft) {
    if (!box) {
      return;
    }

    if (!ensureSignedIn('change box status', 'inventory')) {
      return;
    }

    try {
      const payload = buildFilmCheckinPayload(box, draft);
      const checkInWarnings = getCheckInWarnings(box, payload.lastRollWeightLbs!, {
        currentFeetOnRoll: payload.currentFeetOnRoll,
        coreType: payload.coreType || box.coreType || undefined
      });
      if (!confirmWarnings(checkInWarnings)) {
        return;
      }

      const priorCheckoutJobNumber = box.lastCheckoutJob.trim();
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

      setIsFilmCheckinOpen(false);
      const didMoveToZeroed = result.box.status === 'ZEROED';
      await pushUndoToast(
        result.logId,
        didMoveToZeroed ? 'Moved to zeroed out inventory' : 'Box checked in',
        result.box.boxId,
        warnings,
        didMoveToZeroed ? `${result.box.boxId} was moved to zeroed out inventory.` : undefined
      );

      if (!priorCheckoutJobNumber && didMoveToZeroed) {
        navigate('/');
      }
    } catch (error) {
      pushToast({
        title: 'Status change failed',
        description:
          error instanceof Error ? error.message : 'The status update could not be completed.',
        variant: 'error'
      });
    }
  }

  async function handleOrderedReceiveConfirm(draft: OrderedBoxReceiveDraft) {
    if (!box) {
      return;
    }

    if (!ensureSignedIn('receive this ordered box', 'inventory')) {
      return;
    }

    try {
      const { result, warnings } = await receiveOrderedBox(buildReceiveOrderedBoxPayload(box, draft));
      setIsOrderedReceiveOpen(false);
      await pushUndoToast(
        result.logId,
        'Box received',
        result.box.boxId,
        warnings,
        `${result.box.boxId} was received and moved into in-stock inventory.`,
        {
          plannerSummary: ORDERED_RECEIVE_PLANNER_WARNING_SUMMARY
        }
      );
    } catch (error) {
      pushToast({
        title: 'Receive failed',
        description:
          error instanceof Error ? error.message : 'The ordered box could not be received.',
        variant: 'error'
      });
    }
  }

  function resetEditWorkflow() {
    setPendingZeroedEditState(null);
    setPendingZeroedReactivationState(null);
  }

  function handleCancelZeroedEdit() {
    resetEditWorkflow();
  }

  function handleKeepActiveZeroedEdit(payload: PendingZeroedEditState['activePayload']) {
    resetEditWorkflow();
    void runStandardUpdateFlow(payload);
  }

  function handleConfirmZeroedEdit(payload: PendingZeroedEditState['zeroedPayload']) {
    resetEditWorkflow();
    void runStandardUpdateFlow(payload);
  }

  function handleCancelZeroedReactivation() {
    resetEditWorkflow();
  }

  function handleConfirmZeroedReactivation(payload: PendingZeroedReactivationState['payload']) {
    resetEditWorkflow();
    void runStandardUpdateFlow(payload);
  }

  return {
    confirmState,
    isFilmCheckinOpen,
    isOrderedReceiveOpen,
    pendingZeroedEditState,
    pendingZeroedReactivationState,
    handleDeleteBox,
    handleEditSubmit,
    handleStatusChange,
    handleCancelConfirm,
    handleCancelFilmCheckin,
    handleCancelOrderedReceive,
    openOrderedReceiveDialog,
    handleConfirm,
    handleFilmCheckinConfirm,
    handleOrderedReceiveConfirm,
    resetEditWorkflow,
    handleCancelZeroedEdit,
    handleKeepActiveZeroedEdit,
    handleConfirmZeroedEdit,
    handleCancelZeroedReactivation,
    handleConfirmZeroedReactivation
  };
}
