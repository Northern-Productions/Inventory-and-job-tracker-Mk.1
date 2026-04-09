import { Button } from '../../../../components/Button';

interface ApprovalNoteDialogProps {
  canWriteAccess: boolean;
  noteDraft: string;
  open: boolean;
  pending: boolean;
  onChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}

export function ApprovalNoteDialog({
  canWriteAccess,
  noteDraft,
  open,
  pending,
  onChange,
  onClose,
  onSubmit
}: ApprovalNoteDialogProps) {
  if (!open) {
    return null;
  }

  return (
    <div className="dialog-backdrop" role="presentation" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="approval-note-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="approval-note-title">Approval note</h2>
        <label className="field">
          <span className="field-label">Note</span>
          <textarea
            className="field-input field-textarea"
            value={noteDraft}
            onChange={(event) => onChange(event.target.value)}
            rows={4}
            placeholder="Optional note"
            autoFocus
          />
        </label>
        <div className="dialog-actions">
          <Button type="button" onClick={onSubmit} disabled={!canWriteAccess || pending}>
            {pending ? 'Submitting...' : 'Submit'}
          </Button>
        </div>
      </div>
    </div>
  );
}
