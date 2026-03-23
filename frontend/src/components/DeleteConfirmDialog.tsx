import { useEffect, useId, useState } from 'react';
import { Button } from './Button';
import { DialogSurface } from './DialogSurface';
import { Input } from './Input';

interface DeleteConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmWord?: string;
  pending?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DeleteConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  confirmWord = 'delete',
  pending = false,
  onCancel,
  onConfirm
}: DeleteConfirmDialogProps) {
  const [confirmText, setConfirmText] = useState('');
  const titleId = useId();
  const messageId = useId();
  const normalizedConfirmWord = confirmWord.trim().toLowerCase();
  const isUnlocked = confirmText.trim().toLowerCase() === normalizedConfirmWord;

  useEffect(() => {
    if (!open) {
      setConfirmText('');
    }
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <DialogSurface
      open={open}
      onClose={pending ? undefined : onCancel}
      titleId={titleId}
      descriptionId={message ? messageId : undefined}
      className="delete-dialog"
      backdropClassName="delete-dialog-backdrop"
      closeOnBackdrop={!pending}
      closeOnEscape={!pending}
      role="alertdialog"
    >
      <p className="delete-dialog-eyebrow">Warning</p>
      <h2 id={titleId}>{title}</h2>
      <p id={messageId} className="delete-dialog-message">
        {message}
      </p>
      <Input
        label={`Type "${confirmWord}" to unlock delete`}
        value={confirmText}
        onChange={(event) => setConfirmText(event.target.value)}
        placeholder={normalizedConfirmWord}
        autoFocus
        hint={`Enter ${normalizedConfirmWord} to enable the ${confirmLabel} button.`}
      />
      <div className="dialog-actions delete-dialog-actions">
        <Button type="button" variant="ghost" fullWidth onClick={onCancel} disabled={pending}>
          {cancelLabel}
        </Button>
        <Button
          type="button"
          variant="danger"
          fullWidth
          onClick={onConfirm}
          disabled={!isUnlocked || pending}
        >
          {pending ? 'Deleting...' : confirmLabel}
        </Button>
      </div>
    </DialogSurface>
  );
}
