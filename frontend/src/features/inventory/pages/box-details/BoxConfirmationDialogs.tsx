import { useId } from 'react';
import { Button } from '../../../../components/Button';
import type { BoxTransferEntry } from '../../../../domain';
import { ConfirmDialog } from '../../../../components/ConfirmDialog';
import { DialogSurface } from '../../../../components/DialogSurface';
import { FilmCheckinDialog } from '../../components/FilmCheckinDialog';
import {
  ZEROED_BOX_REACTIVATION_PROMPT,
  buildZeroedInventoryWarningMessage
} from '../../utils/boxZeroedTransition';
import type { FilmCheckinDraft, OrderedBoxReceiveDraft } from '../../utils/boxHelpers';
import type {
  ConfirmState,
  PendingZeroedEditState,
  PendingZeroedReactivationState,
  TransferActionState
} from './types';
import type { Box } from '../../../../domain';
import { ReceiveOrderedBoxDialog } from './ReceiveOrderedBoxDialog';

interface BoxConfirmationDialogsProps {
  box: Box | null | undefined;
  pendingZeroedEditState: PendingZeroedEditState | null;
  pendingZeroedReactivationState: PendingZeroedReactivationState | null;
  pendingTransfer: BoxTransferEntry | null;
  transferActionState: TransferActionState;
  confirmState: ConfirmState;
  filmCheckinOpen: boolean;
  filmCheckinPending: boolean;
  orderedReceiveOpen: boolean;
  orderedReceivePending: boolean;
  filmCheckinReleaseJobNumber?: string;
  checkoutJobOptions: Array<{ label: string; value: string }>;
  onCancelZeroedEdit: () => void;
  onKeepActiveZeroedEdit: (payload: PendingZeroedEditState['activePayload']) => void;
  onConfirmZeroedEdit: (payload: PendingZeroedEditState['zeroedPayload']) => void;
  onCancelZeroedReactivation: () => void;
  onConfirmZeroedReactivation: (payload: PendingZeroedReactivationState['payload']) => void;
  onCancelTransferAction: () => void;
  onConfirmReceiveTransfer: () => void;
  onConfirmCancelTransfer: () => void;
  onCancelStatusConfirm: () => void;
  onCancelFilmCheckin: () => void;
  onCancelOrderedReceive: () => void;
  onConfirmFilmCheckin: (draft: FilmCheckinDraft) => void;
  onConfirmOrderedReceive: (draft: OrderedBoxReceiveDraft) => void;
  onConfirmStatusConfirm: (reason: string) => void;
}

export function BoxConfirmationDialogs({
  box,
  pendingZeroedEditState,
  pendingZeroedReactivationState,
  pendingTransfer,
  transferActionState,
  confirmState,
  filmCheckinOpen,
  filmCheckinPending,
  orderedReceiveOpen,
  orderedReceivePending,
  filmCheckinReleaseJobNumber,
  checkoutJobOptions,
  onCancelZeroedEdit,
  onKeepActiveZeroedEdit,
  onConfirmZeroedEdit,
  onCancelZeroedReactivation,
  onConfirmZeroedReactivation,
  onCancelTransferAction,
  onConfirmReceiveTransfer,
  onConfirmCancelTransfer,
  onCancelStatusConfirm,
  onCancelFilmCheckin,
  onCancelOrderedReceive,
  onConfirmFilmCheckin,
  onConfirmOrderedReceive,
  onConfirmStatusConfirm
}: BoxConfirmationDialogsProps) {
  const zeroedEditTitleId = useId();
  const zeroedEditMessageId = useId();

  return (
    <>
      <DialogSurface
        open={Boolean(pendingZeroedEditState)}
        onClose={onCancelZeroedEdit}
        titleId={zeroedEditTitleId}
        descriptionId={pendingZeroedEditState ? zeroedEditMessageId : undefined}
      >
        <div className="dialog-header">
          <h2 id={zeroedEditTitleId}>Move Box To Zeroed Inventory?</h2>
          <button
            type="button"
            className="dialog-close"
            aria-label="Close dialog"
            onClick={onCancelZeroedEdit}
          >
            x
          </button>
        </div>
        <p id={zeroedEditMessageId} className="muted-text dialog-message">
          {pendingZeroedEditState
            ? buildZeroedInventoryWarningMessage(
                pendingZeroedEditState.missingFields,
                pendingZeroedEditState.trigger
              )
            : ''}
        </p>
        <div className="dialog-actions">
          <Button type="button" variant="ghost" fullWidth onClick={onCancelZeroedEdit}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="secondary"
            fullWidth
            onClick={() => {
              if (!pendingZeroedEditState) {
                return;
              }

              onKeepActiveZeroedEdit(pendingZeroedEditState.activePayload);
            }}
          >
            Keep Active
          </Button>
          <Button
            type="button"
            variant="danger"
            fullWidth
            onClick={() => {
              if (!pendingZeroedEditState) {
                return;
              }

              onConfirmZeroedEdit(pendingZeroedEditState.zeroedPayload);
            }}
          >
            Move To Zeroed
          </Button>
        </div>
      </DialogSurface>

      <ConfirmDialog
        open={Boolean(pendingZeroedReactivationState)}
        title="Reactivate Zeroed Box?"
        message={ZEROED_BOX_REACTIVATION_PROMPT}
        confirmLabel="YES"
        cancelLabel="NO"
        onCancel={onCancelZeroedReactivation}
        onConfirm={() => {
          if (!pendingZeroedReactivationState) {
            return;
          }

          onConfirmZeroedReactivation(pendingZeroedReactivationState.payload);
        }}
      />

      <ConfirmDialog
        open={transferActionState === 'receive'}
        title="Receive Transfer?"
        message={
          pendingTransfer
            ? `Receive ${pendingTransfer.sourceBoxId} into ${pendingTransfer.destinationWarehouse}? The box ID will change to ${pendingTransfer.destinationBoxId}.`
            : ''
        }
        confirmLabel="Receive Box"
        cancelLabel="Cancel"
        onCancel={onCancelTransferAction}
        onConfirm={onConfirmReceiveTransfer}
      />

      <ConfirmDialog
        open={transferActionState === 'cancel'}
        title="Cancel Transfer?"
        message={
          pendingTransfer
            ? `Cancel the transfer from ${pendingTransfer.sourceWarehouse} to ${pendingTransfer.destinationWarehouse}? Any active allocations for jobs in ${pendingTransfer.destinationWarehouse} will be released back to this box.`
            : ''
        }
        confirmLabel="Cancel Transfer"
        cancelLabel="Keep Transfer"
        onCancel={onCancelTransferAction}
        onConfirm={onConfirmCancelTransfer}
      />

      <FilmCheckinDialog
        open={filmCheckinOpen}
        box={box}
        pending={filmCheckinPending}
        releaseJobNumber={filmCheckinReleaseJobNumber}
        onCancel={onCancelFilmCheckin}
        onConfirm={onConfirmFilmCheckin}
      />

      <ReceiveOrderedBoxDialog
        open={orderedReceiveOpen}
        box={box}
        pending={orderedReceivePending}
        onCancel={onCancelOrderedReceive}
        onConfirm={onConfirmOrderedReceive}
      />

      <ConfirmDialog
        open={Boolean(confirmState)}
        title="Check Out Box"
        message={confirmState?.message || ''}
        confirmLabel="Check Out"
        cancelLabel="Cancel"
        requireReason
        reasonLabel={
          checkoutJobOptions.length > 0
            ? 'Allocated Job'
            : 'Job Number'
        }
        reasonPlaceholder="Numbers only"
        reasonField="input"
        reasonInputType="text"
        reasonInputMode="numeric"
        reasonInputPattern="[0-9]*"
        reasonDigitsOnly
        reasonOptions={checkoutJobOptions.length > 0 ? checkoutJobOptions : undefined}
        reasonSelectLabel="Allocated Job"
        reasonAllowCustomOption={checkoutJobOptions.length > 0}
        reasonCustomOptionLabel="Enter New Job Number"
        customReasonLabel="New Job Number"
        onCancel={onCancelStatusConfirm}
        onConfirm={onConfirmStatusConfirm}
      />
    </>
  );
}
