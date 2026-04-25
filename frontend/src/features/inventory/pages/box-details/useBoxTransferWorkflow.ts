import { useEffect, useMemo, useState } from 'react';
import type {
  Box,
  BoxTransferEntry,
  BoxTransferMutationResult,
  BoxTransferPlanResponse,
  CancelBoxTransferPayload,
  ReceiveBoxTransferPayload,
  StartBoxTransferPayload,
  Warehouse,
  WarehouseEntry
} from '../../../../domain';
import type { useToast } from '../../../../components/Toast';
import {
  isWarehousePrefixOnlyBoxId,
  normalizeCreateBoxIdForWarehouse
} from '../../../../lib/boxIds';
import { formatMutationWarningDescription } from '../../../../lib/mutationWarnings';
import { useBoxTransferPlan } from '../../hooks/useInventoryQueries';
import type { TransferActionState, TransferDestinationAnalysis } from './types';

type PushToast = ReturnType<typeof useToast>['push'];
type MutationFn<Payload> = (payload: Payload) => Promise<{
  result: BoxTransferMutationResult;
  warnings: string[];
}>;

interface UseBoxTransferWorkflowArgs {
  box: Box | undefined;
  pendingTransfer: BoxTransferEntry | null;
  transferDestinationAnalysis: TransferDestinationAnalysis;
  warehouseEntries: WarehouseEntry[];
  ensureSignedIn: (actionLabel: string, feature: 'inventory' | 'allocations') => boolean;
  pushToast: PushToast;
  startTransfer: MutationFn<StartBoxTransferPayload>;
  startTransferPending: boolean;
  receiveTransfer: MutationFn<ReceiveBoxTransferPayload>;
  receiveTransferPending: boolean;
  cancelTransfer: MutationFn<CancelBoxTransferPayload>;
  cancelTransferPending: boolean;
}

function buildTransferPlanConflictMessage(plan: BoxTransferPlanResponse | null) {
  if (!plan || plan.available) {
    return '';
  }

  if (plan.conflictType === 'alias' && plan.conflictBoxId) {
    return `Arrival ID ${plan.destinationBoxId} is already kept as an alias for ${plan.conflictBoxId}.`;
  }

  if (plan.conflictType === 'pending_transfer') {
    return `Arrival ID ${plan.destinationBoxId} is already reserved by another pending transfer.`;
  }

  return `Arrival ID ${plan.destinationBoxId} already exists.`;
}

export function useBoxTransferWorkflow({
  box,
  pendingTransfer,
  transferDestinationAnalysis,
  warehouseEntries,
  ensureSignedIn,
  pushToast,
  startTransfer,
  startTransferPending,
  receiveTransfer,
  receiveTransferPending,
  cancelTransfer,
  cancelTransferPending
}: UseBoxTransferWorkflowArgs) {
  const [isTransferDialogOpen, setIsTransferDialogOpen] = useState(false);
  const [isTransferRenameDialogOpen, setIsTransferRenameDialogOpen] = useState(false);
  const [transferDestination, setTransferDestination] = useState<Warehouse | ''>('');
  const [transferNotes, setTransferNotes] = useState('');
  const [transferDestinationBoxIdOverride, setTransferDestinationBoxIdOverride] = useState('');
  const [handledTransferConflictKey, setHandledTransferConflictKey] = useState('');
  const [transferActionState, setTransferActionState] = useState<TransferActionState>(null);

  useEffect(() => {
    setIsTransferDialogOpen(false);
    setIsTransferRenameDialogOpen(false);
    setTransferActionState(null);
    setTransferDestination('');
    setTransferNotes('');
    setTransferDestinationBoxIdOverride('');
    setHandledTransferConflictKey('');
  }, [box?.boxId]);

  const transferDestinationOptions = useMemo(() => {
    const seenCodes = new Set<string>();
    const options = [
      {
        label: 'Select destination warehouse',
        value: ''
      }
    ];

    for (const entry of warehouseEntries) {
      if (!entry.code || entry.code === box?.warehouse || seenCodes.has(entry.code)) {
        continue;
      }

      seenCodes.add(entry.code);
      options.push({
        label: `${entry.code} - ${entry.name}`,
        value: entry.code
      });
    }

    return options;
  }, [box?.warehouse, warehouseEntries]);

  const selectedDestinationEntry = useMemo(
    () => warehouseEntries.find((entry) => entry.code === transferDestination) || null,
    [transferDestination, warehouseEntries]
  );
  const transferDestinationPrefix = useMemo(
    () => (selectedDestinationEntry?.boxIdPrefix || selectedDestinationEntry?.code || '').trim().toUpperCase(),
    [selectedDestinationEntry]
  );
  const isTransferOverridePrefixOnly = Boolean(
    transferDestinationBoxIdOverride &&
      transferDestinationPrefix &&
      isWarehousePrefixOnlyBoxId(transferDestinationBoxIdOverride, transferDestinationPrefix)
  );
  const shouldFetchTransferPlan =
    isTransferDialogOpen &&
    Boolean(box?.boxId) &&
    Boolean(transferDestination) &&
    !transferDestinationAnalysis.conflictMessage &&
    !transferDestinationAnalysis.isResolvingAllocations &&
    !isTransferOverridePrefixOnly;
  const transferPlanQuery = useBoxTransferPlan(
    box && transferDestination
      ? {
          boxId: box.boxId,
          toWarehouse: transferDestination,
          destinationBoxIdOverride: transferDestinationBoxIdOverride.trim() || undefined
        }
      : null,
    {
      enabled: shouldFetchTransferPlan
    }
  );
  const transferPlan = shouldFetchTransferPlan ? transferPlanQuery.data ?? null : null;
  const transferPlanPending =
    shouldFetchTransferPlan && (transferPlanQuery.isLoading || transferPlanQuery.isFetching);
  const transferPlanErrorMessage =
    shouldFetchTransferPlan && transferPlanQuery.error instanceof Error
      ? transferPlanQuery.error.message
      : '';
  const transferPlanConflictMessage = buildTransferPlanConflictMessage(transferPlan);
  const transferMutationsPending =
    startTransferPending || receiveTransferPending || cancelTransferPending;
  const currentTransferConflictKey =
    transferPlan && !transferPlan.available
      ? `${transferDestination}:${transferPlan.destinationBoxId}:${transferPlan.conflictType || ''}:${transferPlan.conflictBoxId || ''}`
      : '';

  useEffect(() => {
    if (!currentTransferConflictKey || currentTransferConflictKey === handledTransferConflictKey) {
      return;
    }

    setTransferDestinationBoxIdOverride((current) =>
      current.trim()
        ? normalizeCreateBoxIdForWarehouse(current, transferDestinationPrefix)
        : transferPlan?.destinationBoxId || normalizeCreateBoxIdForWarehouse('', transferDestinationPrefix)
    );
    setIsTransferRenameDialogOpen(true);
    setHandledTransferConflictKey(currentTransferConflictKey);
  }, [
    currentTransferConflictKey,
    handledTransferConflictKey,
    transferDestinationPrefix,
    transferPlan?.destinationBoxId
  ]);

  function openTransferDialog() {
    if (!box) {
      return;
    }

    setTransferNotes('');
    setTransferDestination(transferDestinationAnalysis.suggestedDestination || '');
    setTransferDestinationBoxIdOverride('');
    setHandledTransferConflictKey('');
    setIsTransferRenameDialogOpen(false);
    setIsTransferDialogOpen(true);
  }

  function closeTransferDialog() {
    setIsTransferDialogOpen(false);
    setIsTransferRenameDialogOpen(false);
    setTransferNotes('');
    setTransferDestination('');
    setTransferDestinationBoxIdOverride('');
    setHandledTransferConflictKey('');
  }

  function handleTransferDestinationChange(value: Warehouse | '') {
    setTransferDestination(value);
    setTransferDestinationBoxIdOverride('');
    setHandledTransferConflictKey('');
    setIsTransferRenameDialogOpen(false);
  }

  function handleTransferDestinationBoxIdOverrideChange(value: string) {
    setTransferDestinationBoxIdOverride(
      normalizeCreateBoxIdForWarehouse(value, transferDestinationPrefix || transferDestination)
    );
  }

  function openTransferRenameDialog() {
    setTransferDestinationBoxIdOverride((current) =>
      current.trim()
        ? normalizeCreateBoxIdForWarehouse(current, transferDestinationPrefix)
        : transferPlan?.destinationBoxId || normalizeCreateBoxIdForWarehouse('', transferDestinationPrefix)
    );
    setIsTransferRenameDialogOpen(true);
  }

  function closeTransferRenameDialog() {
    setIsTransferRenameDialogOpen(false);
  }

  function applyTransferRenameDialog() {
    if (!transferPlan?.available) {
      return;
    }

    setIsTransferRenameDialogOpen(false);
  }

  async function handleStartTransfer() {
    if (!box) {
      return;
    }

    if (!ensureSignedIn('start box transfers', 'inventory')) {
      return;
    }

    if (!transferDestination) {
      pushToast({
        title: 'Destination required',
        description: 'Choose the warehouse this box is being sent to before starting the transfer.',
        variant: 'error'
      });
      return;
    }

    if (transferDestinationAnalysis.conflictMessage) {
      pushToast({
        title: 'Unable to start transfer',
        description: transferDestinationAnalysis.conflictMessage,
        variant: 'error'
      });
      return;
    }

    if (transferPlanPending) {
      pushToast({
        title: 'Checking arrival ID',
        description: 'Wait for the destination Box ID check to finish before sending this transfer.',
        variant: 'error'
      });
      return;
    }

    if (isTransferOverridePrefixOnly) {
      pushToast({
        title: 'Arrival ID incomplete',
        description: 'Add characters after the destination warehouse prefix before using a custom arrival ID.',
        variant: 'error'
      });
      return;
    }

    if (!transferPlan?.available) {
      pushToast({
        title: 'Arrival ID unavailable',
        description:
          transferPlanConflictMessage ||
          transferPlanErrorMessage ||
          'Choose a unique arrival Box ID before starting the transfer.',
        variant: 'error'
      });
      return;
    }

    try {
      const { result, warnings } = await startTransfer({
        boxId: box.boxId,
        toWarehouse: transferDestination,
        notes: transferNotes.trim() || undefined,
        destinationBoxIdOverride: transferDestinationBoxIdOverride.trim() || undefined
      });
      closeTransferDialog();
      pushToast({
        title: 'Transfer started',
        description: formatMutationWarningDescription(
          warnings,
          `${result.box.boxId} is now marked for transfer from ${result.transfer.sourceWarehouse} to ${result.transfer.destinationWarehouse}. Reserved arrival ID: ${result.transfer.destinationBoxId}.`,
          'start-box-transfer'
        ),
        variant: 'success'
      });
    } catch (error) {
      pushToast({
        title: 'Unable to start transfer',
        description: error instanceof Error ? error.message : 'The transfer could not be started.',
        variant: 'error'
      });
    }
  }

  async function handleReceiveTransfer() {
    if (!pendingTransfer) {
      return;
    }

    if (!ensureSignedIn('receive box transfers', 'inventory')) {
      return;
    }

    try {
      const { result, warnings } = await receiveTransfer({
        transferId: pendingTransfer.transferId
      });
      setTransferActionState(null);
      pushToast({
        title: 'Transfer received',
        description: formatMutationWarningDescription(
          warnings,
          `${result.transfer.sourceBoxId} was received into ${result.transfer.destinationWarehouse} as ${result.transfer.destinationBoxId}.`,
          'receive-box-transfer'
        ),
        variant: 'success'
      });
    } catch (error) {
      pushToast({
        title: 'Unable to receive transfer',
        description: error instanceof Error ? error.message : 'The transfer could not be received.',
        variant: 'error'
      });
    }
  }

  async function handleCancelTransfer() {
    if (!pendingTransfer) {
      return;
    }

    if (!ensureSignedIn('cancel box transfers', 'inventory')) {
      return;
    }

    try {
      const { result, warnings } = await cancelTransfer({
        transferId: pendingTransfer.transferId,
        reason: 'Cancelled from box details.'
      });
      setTransferActionState(null);
      const cancellationSummary =
        result.cancelledAllocationCount > 0
          ? `Cancelled ${result.cancelledAllocationCount} cross-warehouse allocation${result.cancelledAllocationCount === 1 ? '' : 's'} and released ${result.releasedFeet} LF.`
          : `${result.box.boxId} is back in stock in ${result.transfer.sourceWarehouse}.`;
      pushToast({
        title: 'Transfer cancelled',
        description: formatMutationWarningDescription(
          warnings,
          cancellationSummary,
          'cancel-box-transfer'
        ),
        variant: 'success'
      });
    } catch (error) {
      pushToast({
        title: 'Unable to cancel transfer',
        description: error instanceof Error ? error.message : 'The transfer could not be cancelled.',
        variant: 'error'
      });
    }
  }

  return {
    isTransferDialogOpen,
    isTransferRenameDialogOpen,
    transferDestination,
    transferDestinationOptions,
    transferDestinationPrefix,
    transferDestinationBoxIdOverride,
    transferNotes,
    transferActionState,
    transferMutationsPending,
    transferPlan,
    transferPlanPending,
    transferPlanErrorMessage,
    transferPlanConflictMessage,
    isTransferOverridePrefixOnly,
    setTransferNotes,
    setTransferActionState,
    handleTransferDestinationChange,
    handleTransferDestinationBoxIdOverrideChange,
    openTransferDialog,
    closeTransferDialog,
    openTransferRenameDialog,
    closeTransferRenameDialog,
    applyTransferRenameDialog,
    handleStartTransfer,
    handleReceiveTransfer,
    handleCancelTransfer
  };
}
