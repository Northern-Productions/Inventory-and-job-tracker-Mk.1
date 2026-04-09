import { Button } from '../../../../components/Button';
import { DialogSurface } from '../../../../components/DialogSurface';
import { Input } from '../../../../components/Input';

interface JobCustomWidthDialogProps {
  open: boolean;
  customWidthDraft: string;
  isCustomWidthValid: boolean;
  onClose: () => void;
  onDraftChange: (value: string) => void;
  onSave: () => void;
}

export function JobCustomWidthDialog({
  open,
  customWidthDraft,
  isCustomWidthValid,
  onClose,
  onDraftChange,
  onSave
}: JobCustomWidthDialogProps) {
  if (!open) {
    return null;
  }

  return (
    <DialogSurface
      open={open}
      onClose={onClose}
      className="width-dialog"
      titleId="job-custom-width-title"
      closeOnBackdrop
    >
      <div className="dialog-header">
        <h2 id="job-custom-width-title">Custom Width</h2>
        <button
          type="button"
          className="dialog-close"
          aria-label="Close custom width dialog"
          onClick={onClose}
        >
          x
        </button>
      </div>
      <Input
        label="Width In"
        type="number"
        step="0.01"
        min="0.01"
        value={customWidthDraft}
        onChange={(event) => onDraftChange(event.target.value)}
        autoFocus
      />
      <div className="dialog-actions dialog-actions-center">
        <Button
          type="button"
          variant="primary"
          className="custom-width-save"
          onClick={onSave}
          disabled={!isCustomWidthValid}
        >
          Save
        </Button>
      </div>
    </DialogSurface>
  );
}
