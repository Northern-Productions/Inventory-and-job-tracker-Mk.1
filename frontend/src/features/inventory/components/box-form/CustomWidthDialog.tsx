import { Button } from '../../../../components/Button';
import { DialogSurface } from '../../../../components/DialogSurface';
import { Input } from '../../../../components/Input';

interface CustomWidthDialogProps {
  customWidthDraft: string;
  open: boolean;
  valid: boolean;
  onChange: (value: string) => void;
  onClose: () => void;
  onSave: () => void;
}

export function CustomWidthDialog({
  customWidthDraft,
  open,
  valid,
  onChange,
  onClose,
  onSave
}: CustomWidthDialogProps) {
  if (!open) {
    return null;
  }

  return (
    <DialogSurface
      open={open}
      onClose={onClose}
      className="width-dialog"
      titleId="custom-width-title"
      closeOnBackdrop
    >
      <div className="dialog-header">
        <h2 id="custom-width-title">Custom Width</h2>
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
        min="0"
        value={customWidthDraft}
        onChange={(event) => onChange(event.target.value)}
        autoFocus
      />
      <div className="dialog-actions dialog-actions-center">
        <Button
          type="button"
          variant="primary"
          className="custom-width-save"
          onClick={onSave}
          disabled={!valid}
        >
          Save
        </Button>
      </div>
    </DialogSurface>
  );
}
