import { useEffect, useState, type InputHTMLAttributes } from 'react';
import { Button } from './Button';
import { Input, TextArea } from './Input';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
  requireReason?: boolean;
  reasonLabel?: string;
  reasonPlaceholder?: string;
  reasonField?: 'textarea' | 'input';
  reasonInputType?: InputHTMLAttributes<HTMLInputElement>['type'];
  reasonInputStep?: InputHTMLAttributes<HTMLInputElement>['step'];
  reasonInputMin?: InputHTMLAttributes<HTMLInputElement>['min'];
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel = 'Cancel',
  requireReason = false,
  reasonLabel = 'Reason',
  reasonPlaceholder = 'Required',
  reasonField = 'textarea',
  reasonInputType = 'text',
  reasonInputStep,
  reasonInputMin,
  onCancel,
  onConfirm
}: ConfirmDialogProps) {
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (!open) {
      setReason('');
    }
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <h2 id="dialog-title">{title}</h2>
        <p className="muted-text">{message}</p>
        {requireReason ? (
          reasonField === 'input' ? (
            <Input
              label={reasonLabel}
              type={reasonInputType}
              step={reasonInputStep}
              min={reasonInputMin}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder={reasonPlaceholder}
              autoFocus
            />
          ) : (
            <TextArea
              label={reasonLabel}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={4}
              placeholder={reasonPlaceholder}
            />
          )
        ) : null}
        <div className="dialog-actions">
          <Button type="button" variant="ghost" fullWidth onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant="danger"
            fullWidth
            onClick={() => onConfirm(reason.trim())}
            disabled={requireReason && !reason.trim()}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
