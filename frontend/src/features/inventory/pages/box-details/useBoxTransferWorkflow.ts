import { useEffect, useMemo, useState } from 'react';
import type {
  Box,
  BoxTransferEntry,
  BoxTransferMutationResult,
  CancelBoxTransferPayload,
  ReceiveBoxTransferPayload,
  StartBoxTransferPayload,
  Warehouse,
  WarehouseEntry
} from '../../../../domain';
import type { useToast } from '../../../../components/Toast';
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
  const [transferDestination, setTransferDestination] = useState<Warehouse | ''>('');
  const [transferNotes, setTransferNotes] = useState('');
  const [transferActionState, setTransferActionState] = useState<TransferActionState>(null);

  useEffect(() => {
    setIsTransferDialogOpen(false);
    setTransferActionState(null);
    setTransferDestination('');
    setTransferNotes('');
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
        label: `${entry.code} · ${entry.name}`,
        value: entry.code
      });
    }

    return options;
  }, [box?.warehouse, warehouseEntries]);

  const transferMutationsPending =
    startTransferPending || receiveTransferPending || cancelTransferPending;

  function openTransferDialog() {
    if (!box) {
      return;
    }

    setTransferNotes('');
    setTransferDestination(transferDestinationAnalysis.suggestedDestination || '');
    setIsTransferDialogOpen(true);
  }

  function closeTransferDialog() {
    setIsTransferDialogOpen(false);
    setTransferNotes('');
    setTransferDestination('');
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

    try {
      const { result, warnings } = await startTransfer({
        boxId: box.boxId,
        toWarehouse: transferDestination,
        notes: transferNotes.trim() || undefined
      });
      closeTransferDialog();
      pushToast({
        title: 'Transfer started',
        description:
          warnings.join(' ') ||
          `${result.box.boxId} is now marked for transfer from ${result.transfer.sourceWarehouse} to ${result.transfer.destinationWarehouse}.`,
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
        description:
          warnings.join(' ') ||
          `${result.transfer.sourceBoxId} was received into ${result.transfer.destinationWarehouse} as ${result.box.boxId}.`,
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
        description: warnings.join(' ') || cancellationSummary,
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
    transferDestination,
    transferDestinationOptions,
    transferNotes,
    transferActionState,
    transferMutationsPending,
    setTransferDestination,
    setTransferNotes,
    setTransferActionState,
    openTransferDialog,
    closeTransferDialog,
    handleStartTransfer,
    handleReceiveTransfer,
    handleCancelTransfer
  };
}
