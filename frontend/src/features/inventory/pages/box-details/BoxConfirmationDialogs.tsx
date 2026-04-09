import { useId } from 'react';
import { Button } from '../../../../components/Button';
import type { BoxTransferEntry } from '../../../../domain';
import { ConfirmDialog } from '../../../../components/ConfirmDialog';
import { DialogSurface } from '../../../../components/DialogSurface';
import {
  ZEROED_BOX_REACTIVATION_PROMPT,
  buildZeroedInventoryWarningMessage
} from '../../utils/boxZeroedTransition';
import type {
  ConfirmState,
  PendingZeroedEditState,
  PendingZeroedReactivationState,
  TransferActionState
} from './types';

interface BoxConfirmationDialogsProps {
  pendingZeroedEditState: PendingZeroedEditState | null;
  pendingZeroedReactivationState: PendingZeroedReactivationState | null;
  pendingTransfer: BoxTransferEntry | null;
  transferActionState: TransferActionState;
  confirmState: ConfirmState;
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
  onConfirmStatusConfirm: (reason: string) => void;
}

export function BoxConfirmationDialogs({
  pendingZeroedEditState,
  pendingZeroedReactivationState,
  pendingTransfer,
  transferActionState,
  confirmState,
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

      <ConfirmDialog
        open={Boolean(confirmState)}
        title={confirmState?.type === 'checkout' ? 'Check Out Box' : 'Check In Box'}
        message={confirmState?.message || ''}
        confirmLabel={confirmState?.type === 'checkout' ? 'Check Out' : 'Check In'}
        cancelLabel="Cancel"
        requireReason
        reasonLabel={
          confirmState?.type === 'checkout'
            ? checkoutJobOptions.length > 0
              ? 'Allocated Job'
              : 'Job Number'
            : 'Roll Weight (lbs)'
        }
        reasonPlaceholder={confirmState?.type === 'checkout' ? 'Numbers only' : 'Required'}
        reasonField={confirmState?.type === 'checkout' || confirmState?.type === 'checkin' ? 'input' : 'textarea'}
        reasonInputType={
          confirmState?.type === 'checkin'
            ? 'number'
            : confirmState?.type === 'checkout'
              ? 'text'
              : 'text'
        }
        reasonInputStep={confirmState?.type === 'checkin' ? '0.01' : undefined}
        reasonInputMin={confirmState?.type === 'checkin' ? '0' : undefined}
        reasonInputMode={confirmState?.type === 'checkout' ? 'numeric' : undefined}
        reasonInputPattern={confirmState?.type === 'checkout' ? '[0-9]*' : undefined}
        reasonDigitsOnly={confirmState?.type === 'checkout'}
        reasonOptions={
          confirmState?.type === 'checkout' && checkoutJobOptions.length > 0
            ? checkoutJobOptions
            : undefined
        }
        reasonSelectLabel={confirmState?.type === 'checkout' ? 'Allocated Job' : undefined}
        reasonAllowCustomOption={confirmState?.type === 'checkout' && checkoutJobOptions.length > 0}
        reasonCustomOptionLabel="Enter New Job Number"
        customReasonLabel={confirmState?.type === 'checkout' ? 'New Job Number' : undefined}
        onCancel={onCancelStatusConfirm}
        onConfirm={onConfirmStatusConfirm}
      />
    </>
  );
}
