import { Button } from '../../../../components/Button';
import { DialogSurface } from '../../../../components/DialogSurface';
import { Input, TextArea } from '../../../../components/Input';
import { Select } from '../../../../components/Select';
import { getWarehouseLabel, type BoxTransferPlanResponse, type Warehouse } from '../../../../domain';
import type { TransferDestinationAnalysis } from './types';

interface TransferOption {
  label: string;
  value: string;
}

interface TransferBoxDialogProps {
  open: boolean;
  currentWarehouse: Warehouse;
  transferDestination: Warehouse | '';
  transferDestinationOptions: TransferOption[];
  transferDestinationAnalysis: TransferDestinationAnalysis;
  transferDestinationPrefix: string;
  transferDestinationBoxIdOverride: string;
  transferPlan: BoxTransferPlanResponse | null;
  transferPlanPending: boolean;
  transferPlanErrorMessage: string;
  transferPlanConflictMessage: string;
  isTransferRenameDialogOpen: boolean;
  isTransferOverridePrefixOnly: boolean;
  transferNotes: string;
  pending: boolean;
  onClose: () => void;
  onOpenRenameDialog: () => void;
  onCloseRenameDialog: () => void;
  onApplyRenameDialog: () => void;
  onTransferDestinationChange: (value: Warehouse | '') => void;
  onTransferDestinationBoxIdOverrideChange: (value: string) => void;
  onTransferNotesChange: (value: string) => void;
  onSubmit: () => void;
}

export function TransferBoxDialog({
  open,
  currentWarehouse,
  transferDestination,
  transferDestinationOptions,
  transferDestinationAnalysis,
  transferDestinationPrefix,
  transferDestinationBoxIdOverride,
  transferPlan,
  transferPlanPending,
  transferPlanErrorMessage,
  transferPlanConflictMessage,
  isTransferRenameDialogOpen,
  isTransferOverridePrefixOnly,
  transferNotes,
  pending,
  onClose,
  onOpenRenameDialog,
  onCloseRenameDialog,
  onApplyRenameDialog,
  onTransferDestinationChange,
  onTransferDestinationBoxIdOverrideChange,
  onTransferNotesChange,
  onSubmit
}: TransferBoxDialogProps) {
  if (!open) {
    return null;
  }

  const showTransferPlanStatus =
    Boolean(transferDestination) &&
    !transferDestinationAnalysis.conflictMessage &&
    !transferDestinationAnalysis.isResolvingAllocations;
  const canSubmit =
    Boolean(transferDestination) &&
    !transferDestinationAnalysis.conflictMessage &&
    !transferDestinationAnalysis.isResolvingAllocations &&
    !transferPlanPending &&
    Boolean(transferPlan?.available) &&
    !pending;
  const renameHint = transferDestinationPrefix
    ? `Keep the ${transferDestinationPrefix}- prefix and choose the rest of the ID.`
    : 'Use a destination-prefixed Box ID.';

  return (
    <>
      <DialogSurface
        open={open}
        onClose={onClose}
        titleId="transfer-box-dialog-title"
        descriptionId="transfer-box-dialog-description"
        className="transfer-box-dialog"
      >
        <div className="dialog-header">
          <h2 id="transfer-box-dialog-title">Transfer Box</h2>
          <button type="button" className="dialog-close" aria-label="Close dialog" onClick={onClose}>
            x
          </button>
        </div>
        <p id="transfer-box-dialog-description" className="muted-text dialog-message">
          Start a warehouse transfer for this box. The receiving warehouse arrival ID is planned now
          so it can be reserved before the box shows up.
        </p>
        <div className="form-grid">
          <Input
            label="Current Warehouse"
            value={`${currentWarehouse} - ${getWarehouseLabel(currentWarehouse)}`}
            readOnly
          />
          <Select
            label="Send To"
            options={transferDestinationOptions}
            value={transferDestination}
            onChange={(event) => onTransferDestinationChange(event.target.value as Warehouse | '')}
            autoFocus
          />
        </div>
        {transferDestinationAnalysis.suggestedDestination ? (
          <p className="field-hint">
            Suggested destination: {transferDestinationAnalysis.suggestedDestination}
          </p>
        ) : null}
        {transferDestinationAnalysis.isResolvingAllocations ? (
          <p className="muted-text">Loading active allocation destinations for this box...</p>
        ) : null}
        {transferDestinationAnalysis.conflictMessage ? (
          <p className="error-text">{transferDestinationAnalysis.conflictMessage}</p>
        ) : null}
        {!transferDestinationAnalysis.conflictMessage && transferDestinationAnalysis.resolutionWarning ? (
          <p className="muted-text">{transferDestinationAnalysis.resolutionWarning}</p>
        ) : null}
        {showTransferPlanStatus ? (
          transferPlanPending ? (
            <p className="muted-text">Checking the planned arrival Box ID...</p>
          ) : transferPlanErrorMessage ? (
            <p className="error-text">{transferPlanErrorMessage}</p>
          ) : transferPlan?.available ? (
            <p className="field-hint">Planned arrival ID: {transferPlan.destinationBoxId}</p>
          ) : transferPlan ? (
            <div>
              <p className="error-text">{transferPlanConflictMessage}</p>
              <Button type="button" variant="secondary" onClick={onOpenRenameDialog}>
                Rename Arrival ID
              </Button>
            </div>
          ) : null
        ) : null}
        <TextArea
          label="Transfer Notes"
          rows={3}
          value={transferNotes}
          onChange={(event) => onTransferNotesChange(event.target.value)}
          placeholder="Optional notes for the receiving warehouse"
        />
        <div className="dialog-actions">
          <Button type="button" variant="ghost" fullWidth onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            fullWidth
            onClick={onSubmit}
            loading={pending}
            loadingLabel="Sending..."
            disabled={!canSubmit}
          >
            Send
          </Button>
        </div>
      </DialogSurface>

      <DialogSurface
        open={isTransferRenameDialogOpen}
        onClose={onCloseRenameDialog}
        titleId="transfer-rename-dialog-title"
        descriptionId="transfer-rename-dialog-description"
      >
        <div className="dialog-header">
          <h2 id="transfer-rename-dialog-title">Choose A Different Arrival Box ID</h2>
          <button
            type="button"
            className="dialog-close"
            aria-label="Close dialog"
            onClick={onCloseRenameDialog}
          >
            x
          </button>
        </div>
        <p id="transfer-rename-dialog-description" className="muted-text dialog-message">
          The generated arrival ID conflicts with something that already exists. {renameHint}
        </p>
        <Input
          label="Arrival Box ID"
          value={transferDestinationBoxIdOverride}
          onChange={(event) => onTransferDestinationBoxIdOverrideChange(event.target.value)}
          hint={renameHint}
          autoFocus
        />
        {isTransferOverridePrefixOnly ? (
          <p className="error-text">Add characters after the destination warehouse prefix.</p>
        ) : transferPlanPending ? (
          <p className="muted-text">Checking whether this arrival ID is available...</p>
        ) : transferPlanErrorMessage ? (
          <p className="error-text">{transferPlanErrorMessage}</p>
        ) : transferPlan?.available ? (
          <p className="field-hint">Arrival ID available: {transferPlan.destinationBoxId}</p>
        ) : transferPlanConflictMessage ? (
          <p className="error-text">{transferPlanConflictMessage}</p>
        ) : null}
        <div className="dialog-actions">
          <Button type="button" variant="ghost" fullWidth onClick={onCloseRenameDialog}>
            Cancel
          </Button>
          <Button
            type="button"
            fullWidth
            onClick={onApplyRenameDialog}
            disabled={
              pending ||
              transferPlanPending ||
              isTransferOverridePrefixOnly ||
              !transferPlan?.available
            }
          >
            Use Arrival ID
          </Button>
        </div>
      </DialogSurface>
    </>
  );
}
