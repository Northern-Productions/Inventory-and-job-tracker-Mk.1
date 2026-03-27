import { Button } from '../../../components/Button';
import { DialogSurface } from '../../../components/DialogSurface';

interface LaborOnlyJobConfirmDialogProps {
  open: boolean;
  jobNumber: string;
  pending?: boolean;
  onCancel: () => void;
  onConfirmNormal: () => void;
  onConfirmLaborOnly: () => void;
}

export function LaborOnlyJobConfirmDialog({
  open,
  jobNumber,
  pending = false,
  onCancel,
  onConfirmNormal,
  onConfirmLaborOnly
}: LaborOnlyJobConfirmDialogProps) {
  if (!open) {
    return null;
  }

  const title = jobNumber ? `Labor-Only Job ${jobNumber}?` : 'Labor-Only Job?';

  return (
    <DialogSurface open={open} onClose={onCancel} titleId="labor-only-job-dialog-title">
      <div className="dialog-header">
        <h2 id="labor-only-job-dialog-title">{title}</h2>
        <button type="button" className="dialog-close" aria-label="Close dialog" onClick={onCancel}>
          x
        </button>
      </div>
      <p className="muted-text dialog-message">
        This job has no film LF or caulk tubes. Is it labor only? Choosing labor only will mark it
        staged for pickup and ready.
      </p>
      <div className="dialog-actions">
        <Button type="button" variant="ghost" fullWidth onClick={onCancel} disabled={pending}>
          Keep Editing
        </Button>
        <Button type="button" variant="secondary" fullWidth onClick={onConfirmNormal} disabled={pending}>
          No
        </Button>
        <Button type="button" fullWidth onClick={onConfirmLaborOnly} disabled={pending}>
          {pending ? 'Saving...' : 'Yes, Labor Only'}
        </Button>
      </div>
    </DialogSurface>
  );
}
