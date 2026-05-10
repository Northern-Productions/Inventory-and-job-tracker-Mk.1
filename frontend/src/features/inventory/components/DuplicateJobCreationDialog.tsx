import { Button } from '../../../components/Button';
import { DialogSurface } from '../../../components/DialogSurface';
import type { JobListEntry } from '../../../domain';
import { formatJobDisplayLabel } from '../../../lib/jobDisplay';

interface DuplicateJobCreationDialogProps {
  open: boolean;
  job: JobListEntry | null;
  onEditNewJob: () => void;
  onGoToJob: () => void;
}

export function DuplicateJobCreationDialog({
  open,
  job,
  onEditNewJob,
  onGoToJob
}: DuplicateJobCreationDialogProps) {
  if (!open || !job) {
    return null;
  }

  const isCompleted = job.lifecycleStatus === 'COMPLETED' || job.status === 'COMPLETED';
  const title = isCompleted
    ? 'This job was already completed. What would you like to do?'
    : 'This job already exists and is active.';
  const goLabel = isCompleted ? 'Go to Completed Job' : 'Go to Existing Job';

  return (
    <DialogSurface open={open} onClose={onEditNewJob} titleId="duplicate-job-dialog-title">
      <div className="dialog-header">
        <h2 id="duplicate-job-dialog-title">{title}</h2>
        <button type="button" className="dialog-close" aria-label="Close dialog" onClick={onEditNewJob}>
          x
        </button>
      </div>
      <p className="muted-text dialog-message">
        Existing job: {formatJobDisplayLabel(job)}
      </p>
      <div className="dialog-actions">
        <Button type="button" variant="ghost" fullWidth onClick={onEditNewJob}>
          Edit New Job
        </Button>
        <Button type="button" fullWidth onClick={onGoToJob}>
          {goLabel}
        </Button>
      </div>
    </DialogSurface>
  );
}
