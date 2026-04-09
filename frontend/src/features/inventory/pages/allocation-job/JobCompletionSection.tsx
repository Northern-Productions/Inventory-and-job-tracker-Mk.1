import { Button } from '../../../../components/Button';

type JobCompletionSectionProps = {
  canDeleteJob: boolean;
  isReadOnlyJob: boolean;
  deletePending: boolean;
  completePending: boolean;
  pendingCaulkMutation: boolean;
  completionDisabled: boolean;
  completionBlockedMessage: string;
  onOpenDelete: () => void;
  onOpenComplete: () => void;
};

export function JobCompletionSection({
  canDeleteJob,
  isReadOnlyJob,
  deletePending,
  completePending,
  pendingCaulkMutation,
  completionDisabled,
  completionBlockedMessage,
  onOpenDelete,
  onOpenComplete
}: JobCompletionSectionProps) {
  if (isReadOnlyJob && !canDeleteJob) {
    return null;
  }

  return (
    <section className="panel panel-subtle">
      <div
        className={`page-actions allocation-complete-footer ${
          !isReadOnlyJob && canDeleteJob ? 'allocation-complete-footer-with-delete' : ''
        }`.trim()}
      >
        {canDeleteJob ? (
          <Button
            type="button"
            variant="danger"
            className="job-delete-button"
            onClick={onOpenDelete}
            disabled={deletePending || completePending || pendingCaulkMutation}
          >
            Delete
          </Button>
        ) : null}
        {!isReadOnlyJob ? (
          <Button
            type="button"
            variant="secondary"
            onClick={onOpenComplete}
            disabled={completionDisabled}
          >
            Job Completed
          </Button>
        ) : null}
      </div>
      {!isReadOnlyJob && completionBlockedMessage ? (
        <p className="muted-text allocation-complete-helper">{completionBlockedMessage}</p>
      ) : null}
    </section>
  );
}
