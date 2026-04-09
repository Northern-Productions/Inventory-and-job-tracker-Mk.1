import { Button } from '../../../../components/Button';
import { DialogSurface } from '../../../../components/DialogSurface';
import { Input, TextArea } from '../../../../components/Input';
import { Select } from '../../../../components/Select';
import { getWarehouseLabel, type Warehouse } from '../../../../domain';
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
  transferNotes: string;
  pending: boolean;
  onClose: () => void;
  onTransferDestinationChange: (value: Warehouse | '') => void;
  onTransferNotesChange: (value: string) => void;
  onSubmit: () => void;
}

export function TransferBoxDialog({
  open,
  currentWarehouse,
  transferDestination,
  transferDestinationOptions,
  transferDestinationAnalysis,
  transferNotes,
  pending,
  onClose,
  onTransferDestinationChange,
  onTransferNotesChange,
  onSubmit
}: TransferBoxDialogProps) {
  if (!open) {
    return null;
  }

  return (
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
        Start a warehouse transfer for this box. The box ID prefix will not change until the
        destination warehouse receives it.
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
          disabled={
            !transferDestination ||
            Boolean(transferDestinationAnalysis.conflictMessage) ||
            transferDestinationAnalysis.isResolvingAllocations ||
            pending
          }
        >
          Send
        </Button>
      </div>
    </DialogSurface>
  );
}
