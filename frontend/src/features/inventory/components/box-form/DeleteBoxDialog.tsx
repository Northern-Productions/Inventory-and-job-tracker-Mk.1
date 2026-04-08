import { Button } from '../../../../components/Button';
import { Input } from '../../../../components/Input';

interface DeleteBoxDialogProps {
  backdropClosing: boolean;
  dialogClosing: boolean;
  confirmText: string;
  deleting: boolean;
  open: boolean;
  unlocked: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  onConfirmTextChange: (value: string) => void;
}

export function DeleteBoxDialog({
  backdropClosing,
  dialogClosing,
  confirmText,
  deleting,
  open,
  unlocked,
  onCancel,
  onConfirm,
  onConfirmTextChange
}: DeleteBoxDialogProps) {
  if (!open) {
    return null;
  }

  return (
    <div
      className={`delete-dialog-backdrop ${backdropClosing ? 'delete-dialog-backdrop-closing' : ''}`.trim()}
      role="presentation"
    >
      <div
        className={`dialog delete-dialog ${dialogClosing ? 'delete-dialog-closing' : ''}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-box-title"
        aria-describedby="delete-box-message"
        onClick={(event) => event.stopPropagation()}
      >
        <p className="delete-dialog-eyebrow">Warning</p>
        <h2 id="delete-box-title">Delete Box</h2>
        <p id="delete-box-message" className="delete-dialog-message">
          Are you sure? This action cannot be undone. Type &quot;Delete&quot; in order to delete.
        </p>
        <Input
          label='Type "Delete" to unlock delete'
          value={confirmText}
          onChange={(event) => onConfirmTextChange(event.target.value)}
          placeholder="delete"
          autoFocus
          hint='Enter delete to enable the Delete button.'
        />
        <div className="dialog-actions delete-dialog-actions">
          <Button
            type="button"
            variant="ghost"
            fullWidth
            onClick={onCancel}
            disabled={dialogClosing || deleting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger"
            fullWidth
            onClick={onConfirm}
            disabled={!unlocked || dialogClosing || deleting}
          >
            Delete
          </Button>
        </div>
      </div>
    </div>
  );
}
